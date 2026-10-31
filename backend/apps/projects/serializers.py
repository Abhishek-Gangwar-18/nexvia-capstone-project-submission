from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.accounts.serializers import UserMiniSerializer
from apps.core.fields import TenantPrimaryKeyRelatedField, WorkspaceMemberField

from .models import PROJECT_KEY_VALIDATOR, Board, Project, Sprint, WorkflowStatus


class WorkflowStatusSerializer(serializers.ModelSerializer):
    class Meta:
        model = WorkflowStatus
        fields = ["id", "name", "category", "color", "position"]


class BoardSerializer(serializers.ModelSerializer):
    class Meta:
        model = Board
        fields = ["id", "project", "name", "board_type", "wip_limits"]
        read_only_fields = ["project"]

    def validate_wip_limits(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("Expected an object of {status_id: limit}.")
        cleaned = {}
        for status_id, limit in value.items():
            if limit in (None, "", 0):
                continue
            if not str(status_id).isdigit() or not isinstance(limit, int) or limit < 0:
                raise serializers.ValidationError("Limits must be positive integers keyed by status id.")
            cleaned[str(status_id)] = limit
        return cleaned


class SprintMiniSerializer(serializers.ModelSerializer):
    class Meta:
        model = Sprint
        fields = ["id", "name", "state", "start_date", "end_date"]


class ProjectSerializer(serializers.ModelSerializer):
    # Declared explicitly so the model's uppercase-only validator runs after normalisation.
    key = serializers.CharField(max_length=10)
    lead = WorkspaceMemberField(required=False, allow_null=True)
    lead_detail = UserMiniSerializer(source="lead", read_only=True)
    statuses = serializers.SerializerMethodField()
    board = serializers.SerializerMethodField()
    active_sprint = serializers.SerializerMethodField()
    enforce_transitions = serializers.BooleanField(source="workflow.enforce_transitions", read_only=True)
    issue_count = serializers.IntegerField(read_only=True, default=0)
    done_count = serializers.IntegerField(read_only=True, default=0)
    board_type = serializers.ChoiceField(
        choices=Board.BoardType.choices, write_only=True, required=False, default=Board.BoardType.SCRUM
    )

    class Meta:
        model = Project
        fields = [
            "id", "key", "name", "description", "color", "lead", "lead_detail", "is_archived", "created_at",
            "statuses", "board", "active_sprint", "enforce_transitions", "issue_count", "done_count", "board_type",
        ]
        read_only_fields = ["created_at"]

    def validate_key(self, value):
        value = value.strip().upper()
        PROJECT_KEY_VALIDATOR(value)
        if self.instance and self.instance.key != value:
            raise serializers.ValidationError("A project key can't change once issues reference it.")
        workspace = self.context["request"].workspace
        if not self.instance and Project.objects.for_workspace(workspace).filter(key=value).exists():
            raise serializers.ValidationError("This key is already used by another project.")
        return value

    @extend_schema_field(WorkflowStatusSerializer(many=True))
    def get_statuses(self, obj):
        return WorkflowStatusSerializer(obj.workflow.statuses.all(), many=True).data

    @extend_schema_field(BoardSerializer(allow_null=True))
    def get_board(self, obj):
        board = next(iter(obj.boards.all()), None)
        return BoardSerializer(board).data if board else None

    @extend_schema_field(SprintMiniSerializer(allow_null=True))
    def get_active_sprint(self, obj):
        active = getattr(obj, "active_sprints", None)
        if active is None:
            active = list(obj.sprints.filter(state=Sprint.State.ACTIVE))
        return SprintMiniSerializer(active[0]).data if active else None


class SprintSerializer(serializers.ModelSerializer):
    project = TenantPrimaryKeyRelatedField(queryset=Project.objects.all())
    issue_count = serializers.IntegerField(read_only=True, default=0)
    done_count = serializers.IntegerField(read_only=True, default=0)
    total_points = serializers.IntegerField(read_only=True, default=0)
    done_points = serializers.IntegerField(read_only=True, default=0)
    name = serializers.CharField(max_length=120, required=False, allow_blank=True)

    class Meta:
        model = Sprint
        fields = [
            "id", "project", "name", "goal", "state", "start_date", "end_date", "completed_at",
            "issue_count", "done_count", "total_points", "done_points",
        ]
        read_only_fields = ["state", "completed_at"]

    def validate(self, attrs):
        if self.instance and "project" in attrs and attrs["project"] != self.instance.project:
            raise serializers.ValidationError({"project": "A sprint can't move to another project."})
        start = attrs.get("start_date", getattr(self.instance, "start_date", None))
        end = attrs.get("end_date", getattr(self.instance, "end_date", None))
        if start and end and end < start:
            raise serializers.ValidationError({"end_date": "End date must be on or after the start date."})
        if self.instance and self.instance.state == Sprint.State.CLOSED:
            raise serializers.ValidationError("Closed sprints are read-only.")
        return attrs

    def create(self, validated_data):
        if not validated_data.get("name"):
            project = validated_data["project"]
            validated_data["name"] = f"{project.key} Sprint {project.sprints.count() + 1}"
        return super().create(validated_data)


class SprintStartSerializer(serializers.Serializer):
    start_date = serializers.DateField(required=False)
    end_date = serializers.DateField(required=False)
    goal = serializers.CharField(required=False, allow_blank=True)


class SprintCompleteSerializer(serializers.Serializer):
    # Where unfinished issues go: another planned sprint of the same project, or null = backlog.
    move_open_issues_to = TenantPrimaryKeyRelatedField(
        queryset=Sprint.objects.all(), required=False, allow_null=True, default=None
    )
