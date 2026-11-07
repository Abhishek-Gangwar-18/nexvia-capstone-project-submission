import re

from drf_spectacular.utils import extend_schema_field
from django.db.models import Count
from rest_framework import serializers

from apps.accounts.serializers import UserMiniSerializer
from apps.core.fields import TenantPrimaryKeyRelatedField, WorkspaceMemberField

from .models import PROJECT_KEY_VALIDATOR, Board, Project, Sprint, WorkflowStatus
from .services import next_sprint_name

HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")


def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


class WorkflowStatusSerializer(serializers.ModelSerializer):
    class Meta:
        model = WorkflowStatus
        fields = ["id", "name", "category", "color", "position"]


class WorkflowConfigSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120, required=False)
    enforce_transitions = serializers.BooleanField()
    statuses = serializers.ListField(child=serializers.DictField(), min_length=2, max_length=12)
    # Transition endpoints refer to indexes in the submitted ordered statuses array.
    transitions = serializers.ListField(child=serializers.DictField(), required=False, default=list)

    def validate(self, data):
        project = self.context["project"]
        errors = {}
        statuses = data["statuses"]
        # "position" is accepted so a GET response can be sent straight back; list order decides the real position.
        allowed = {"id", "name", "category", "color", "position"}
        names = []
        categories = {choice for choice, _ in WorkflowStatus.Category.choices}
        # Two queries in total: the current statuses, and issue counts grouped by status (this project only).
        existing = {status.pk: status for status in project.workflow.statuses.all()}
        existing_ids = set(existing)
        in_use = dict(
            project.issues.order_by().values("status_id").annotate(n=Count("id")).values_list("status_id", "n")
        )
        seen_ids = set()
        for index, status in enumerate(statuses):
            if set(status) - allowed:
                errors.setdefault("statuses", {})[index] = "Unknown status fields."
            name = status.get("name")
            category = status.get("category")
            if not isinstance(name, str) or not name.strip() or len(name.strip()) > 40:
                errors.setdefault("statuses", {})[index] = "Name is required (1–40 characters)."
            elif name.strip().casefold() in names:
                errors.setdefault("statuses", {})[index] = "Status names must be unique."
            else:
                names.append(name.strip().casefold())
            if not isinstance(category, str) or category not in categories:
                errors.setdefault("statuses", {})[index] = "Category must be todo, in_progress, or done."
            color = status.get("color", "#64748b")
            if not isinstance(color, str) or not HEX_COLOR.fullmatch(color):
                errors.setdefault("statuses", {})[index] = "Color must be a hex color such as #64748b."
            if "id" in status:
                status_id = status["id"]
                if not isinstance(status_id, int) or isinstance(status_id, bool) or status_id not in existing_ids or status_id in seen_ids:
                    errors.setdefault("statuses", {})[index] = "Status id is invalid or duplicated."
                elif isinstance(category, str) and category in categories:
                    if existing[status_id].category != category and in_use.get(status_id):
                        errors.setdefault("statuses", {})[index] = "A status category cannot change while issues use it."
                if isinstance(status_id, int) and not isinstance(status_id, bool):
                    seen_ids.add(status_id)
        submitted_categories = {status.get("category") for status in statuses if isinstance(status.get("category"), str)}
        if WorkflowStatus.Category.TODO not in submitted_categories or WorkflowStatus.Category.DONE not in submitted_categories:
            errors["statuses"] = "A workflow must retain at least one To do and one Done status."
        present_ids = {s["id"] for s in statuses if isinstance(s.get("id"), int)}
        removed = existing_ids - present_ids
        if any(in_use.get(status_id) for status_id in removed):
            errors["statuses"] = "A status used by issues cannot be removed. Move its issues first."
        transitions = data.get("transitions", [])
        if len(transitions) > len(statuses) * (len(statuses) - 1):
            errors["transitions"] = "There are more transitions than this workflow can contain."
        pairs = set()
        for index, transition in enumerate(transitions):
            source, target = transition.get("from"), transition.get("to")
            if set(transition) != {"from", "to"} or not isinstance(source, int) or isinstance(source, bool) or not isinstance(target, int) or isinstance(target, bool) or source < 0 or target < 0 or source >= len(statuses) or target >= len(statuses) or source == target:
                errors.setdefault("transitions", {})[index] = "Transition must connect two different submitted status indexes."
            elif (source, target) in pairs:
                errors.setdefault("transitions", {})[index] = "Duplicate transition."
            else:
                pairs.add((source, target))
        if errors:
            raise serializers.ValidationError(errors)
        return data


class BoardSerializer(serializers.ModelSerializer):
    class Meta:
        model = Board
        fields = ["id", "project", "name", "board_type", "wip_limits"]
        read_only_fields = ["project"]

    def validate_wip_limits(self, value):
        """{"<status id>": <limit>} for this project's current workflow. null removes a limit."""
        if not isinstance(value, dict):
            raise serializers.ValidationError("Expected an object of {status_id: limit}.")
        valid_ids = {str(pk) for pk in self.instance.project.workflow.statuses.values_list("pk", flat=True)}
        cleaned, errors = {}, {}
        for status_id, limit in value.items():
            if status_id not in valid_ids:
                errors[status_id] = "Not a status of this project's workflow."
            elif limit is None:
                continue
            elif not is_int(limit) or limit < 1:
                errors[status_id] = "Limit must be a whole number of at least 1."
            else:
                cleaned[status_id] = limit
        if errors:
            raise serializers.ValidationError(errors)
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

    def validate_color(self, value):
        if not HEX_COLOR.fullmatch(value):
            raise serializers.ValidationError("Color must be a hex color such as #6366f1.")
        return value

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

    def validate_name(self, value):
        value = value.strip()
        if self.instance is not None and not value:
            raise serializers.ValidationError("Sprint name cannot be blank.")
        return value  # blank on create means "generate one"

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
            validated_data["name"] = next_sprint_name(validated_data["project"])
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


class DeleteProjectSerializer(serializers.Serializer):
    confirm = serializers.CharField(help_text="The project key, typed out to confirm.")

    def validate_confirm(self, value):
        if value.strip().upper() != self.context["project"].key:
            raise serializers.ValidationError("Type the project key exactly to confirm.")
        return value
