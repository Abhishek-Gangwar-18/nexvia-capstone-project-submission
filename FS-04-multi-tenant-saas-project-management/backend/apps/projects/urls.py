from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter(trailing_slash=True)
router.register("projects", views.ProjectViewSet, basename="project")
router.register("boards", views.BoardViewSet, basename="board")
router.register("sprints", views.SprintViewSet, basename="sprint")

urlpatterns = router.urls
