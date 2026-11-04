# REQ-UI-017 — Superset configuration for embedded analytics. Values come from the compose environment.
import os

SECRET_KEY = os.environ["SUPERSET_SECRET_KEY"]
SQLALCHEMY_DATABASE_URI = (
    f"postgresql+psycopg2://{os.environ['DATABASE_USER']}:{os.environ['DATABASE_PASSWORD']}"
    f"@{os.environ['DATABASE_HOST']}:{os.environ['DATABASE_PORT']}/{os.environ['DATABASE_DB']}"
    "?options=-csearch_path%3Dsuperset"
)

# The API grants the embedded guest role its permissions through the security API at provisioning time.
FAB_ADD_SECURITY_API = True

FEATURE_FLAGS = {
    "EMBEDDED_SUPERSET": True,
    "DASHBOARD_RBAC": True,
    "ROW_LEVEL_SECURITY": True,
    "ALERT_REPORTS": True,
}

# Embedding into the OpenMap console: the console origin is injected by the API at runtime via guest tokens.
GUEST_ROLE_NAME = "OpenMapEmbedded"
GUEST_TOKEN_JWT_SECRET = SECRET_KEY
GUEST_TOKEN_JWT_EXP_SECONDS = 300
TALISMAN_ENABLED = False
WTF_CSRF_ENABLED = True
WTF_CSRF_EXEMPT_LIST = ["superset.views.core.log", "superset.security.api.guest_token"]
ENABLE_PROXY_FIX = True
LANGUAGES = {"en": {"flag": "us", "name": "English"}, "ar": {"flag": "sa", "name": "Arabic"}}
BABEL_DEFAULT_LOCALE = "en"

# REQ-UI-031 (ADR-020) — the Horizon look inside the embedded dashboard: the categorical scheme the provisioner names
# on every chart (ANALYTICS.colorScheme) and the theme colours Superset's own chrome uses. Values mirror
# packages/ui/src/tokens/color.ts; the dashboard surfaces come from the dashboard CSS the API provisions.
EXTRA_CATEGORICAL_COLOR_SCHEMES = [
    {
        "id": "openmapHorizon",
        "description": "OpenMap Horizon",
        "label": "OpenMap Horizon",
        "isDefault": True,
        "colors": ["#22D3EE", "#8B5CF6", "#2DD4A0", "#F5B82E", "#FB5B7A", "#38BDF8", "#A78BFA", "#F472B6", "#34D399", "#FBBF24"],
    }
]
THEME_OVERRIDES = {
    "colors": {
        "primary": {"base": "#22D3EE", "dark1": "#06B6D4", "dark2": "#0E7490", "light1": "#67E8F9", "light2": "#A5F3FC", "light3": "#CFFAFE", "light4": "#ECFEFF", "light5": "#F0FDFF"},
        "secondary": {"base": "#8B5CF6", "dark1": "#7C3AED", "dark2": "#6D28D9", "light1": "#A78BFA", "light2": "#C4B5FD", "light3": "#DDD6FE", "light4": "#EDE9FE", "light5": "#F5F3FF"},
        "grayscale": {"base": "#9AA4B8", "dark1": "#5B6578", "dark2": "#070A12", "light1": "#C3CAD9", "light2": "#1A2235", "light3": "#121828", "light4": "#0D1322", "light5": "#0A0F1C"},
        "error": {"base": "#FB5B7A", "dark1": "#E11D48", "dark2": "#BE123C", "light1": "#FDA4AF", "light2": "#FECDD3"},
        "warning": {"base": "#F5B82E", "dark1": "#D97706", "dark2": "#B45309", "light1": "#FCD34D", "light2": "#FDE68A"},
        "success": {"base": "#2DD4A0", "dark1": "#059669", "dark2": "#047857", "light1": "#6EE7B7", "light2": "#A7F3D0"},
    },
    "typography": {"families": {"sansSerif": "'Sora', 'Inter', system-ui, sans-serif", "monospace": "'JetBrains Mono', ui-monospace, monospace"}},
}

