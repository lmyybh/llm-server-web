"""Request and response shapes, and the validation that belongs to them."""

from __future__ import annotations

import re

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ENV_VAR_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

DEFAULT_API_KEY_ENV = "LLM_API_KEY"
DEFAULT_SYNTHETIC_INPUT_LIMIT = 65536


def strip_text(value: str | None) -> str | None:
    return value.strip() if isinstance(value, str) else value


def require_non_blank(value: str | None) -> str | None:
    if value is None:
        return None
    if not value.strip():
        raise ValueError("must not be blank")
    return value


def normalise_router_url(value: str | None) -> str | None:
    """Keep one canonical form, so the same service is never two strings.

    A trailing ``/v1`` is dropped because callers append their own path;
    leaving it would produce ``/v1/v1/completions``.
    """
    if value is None:
        return None
    value = value.strip().rstrip("/")
    if not value.startswith(("http://", "https://")):
        value = f"http://{value}"
    if value.endswith("/v1"):
        value = value[: -len("/v1")].rstrip("/")
    host = value.split("://", 1)[1] if "://" in value else ""
    if not host:
        raise ValueError("router_url has no host")
    return value


def require_env_var_name(value: str | None) -> str | None:
    """Accept the *name* of an environment variable, and refuse anything else.

    This guards against a real mistake rather than a theoretical one: the field
    sits next to a URL and a model name, and pasting the key itself into it is
    what someone in a hurry would do. Real API keys contain characters a POSIX
    name cannot — hyphens, dots, a leading digit — so they are rejected here
    instead of being written to disk.
    """
    if value is None:
        return None
    value = value.strip()
    if not ENV_VAR_NAME.match(value):
        raise ValueError(
            "api_key_env must be the NAME of an environment variable (letters, "
            "digits and underscores, not starting with a digit). The key itself "
            "is never stored — only the name of the variable it is read from."
        )
    return value


class ModelCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    note: str = Field(default="", max_length=2000)

    _strip = field_validator("name", "note")(strip_text)
    _not_blank = field_validator("name")(require_non_blank)


class ModelUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    note: str | None = Field(default=None, max_length=2000)

    _strip = field_validator("name", "note")(strip_text)
    _not_blank = field_validator("name")(require_non_blank)


class DeploymentFields(BaseModel):
    """Everything that identifies a Deployment.

    Note what is absent: there is no field for the API key itself, only for the
    **name of the environment variable** the executor reads it from. Nothing in
    this schema could hold a secret.
    """

    name: str = Field(min_length=1, max_length=200)
    note: str = Field(default="", max_length=2000)
    router_url: str = Field(min_length=1, max_length=500)
    model_name: str = Field(min_length=1, max_length=200)
    api_key_env: str = Field(default=DEFAULT_API_KEY_ENV, max_length=200)
    context_length: int | None = Field(default=None, ge=1)
    synthetic_input_limit: int = Field(default=DEFAULT_SYNTHETIC_INPUT_LIMIT, ge=1)
    gpu_model: str = Field(default="", max_length=200)
    gpu_count: int | None = Field(default=None, ge=1)
    topology: str = Field(default="", max_length=200)
    image: str = Field(default="", max_length=500)

    _strip = field_validator("name", "note", "model_name", "gpu_model", "topology", "image")(strip_text)
    _not_blank = field_validator("name", "model_name", "router_url")(require_non_blank)
    _url = field_validator("router_url")(normalise_router_url)
    _env = field_validator("api_key_env")(require_env_var_name)


def deployment_field_defaults() -> dict:
    """Every optional Deployment field's built-in default.

    Read off the model rather than restated, so adding a field with a default
    cannot leave this layer silently behind.
    """
    return {
        name: field.get_default(call_default_factory=True)
        for name, field in DeploymentFields.model_fields.items()
        if not field.is_required()
    }


class DeploymentCreate(DeploymentFields):
    pass


class ServiceFields(BaseModel):
    """A service to inspect. Four fields, and that is the whole entity.

    Not a Deployment and deliberately not connected to one: inspection answers
    "is this service alright", which does not depend on which model it serves
    or how it is deployed. Same shape as a Deployment's connection details
    because they are the same facts, not because they are the same thing.
    """

    name: str = Field(min_length=1, max_length=200)
    note: str = Field(default="", max_length=2000)
    router_url: str = Field(min_length=1, max_length=500)
    api_key_env: str = Field(default=DEFAULT_API_KEY_ENV, max_length=200)

    _strip = field_validator("name", "note")(strip_text)
    _not_blank = field_validator("name", "router_url")(require_non_blank)
    _url = field_validator("router_url")(normalise_router_url)
    _env = field_validator("api_key_env")(require_env_var_name)


class ServiceCreate(ServiceFields):
    pass


class ServiceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    note: str | None = Field(default=None, max_length=2000)
    router_url: str | None = Field(default=None, min_length=1, max_length=500)
    api_key_env: str | None = Field(default=None, max_length=200)

    _strip = field_validator("name", "note")(strip_text)
    _not_blank = field_validator("name", "router_url")(require_non_blank)
    _url = field_validator("router_url")(normalise_router_url)
    _env = field_validator("api_key_env")(require_env_var_name)


class InspectionCaseSelection(BaseModel):
    case_ids: list[str] = Field(min_length=1)


class WorkloadCreate(BaseModel):
    """A preset load shape in the **global** Workload library.

    Exactly one of two kinds: synthetic — described by input/output token
    counts — or a registered dataset, named. Never both: the two go to
    different endpoints and mean different things. No bench parameters live
    here: mode, level and request count belong to the Cell.
    """

    name: str = Field(min_length=1, max_length=200)
    note: str = Field(default="", max_length=2000)
    kind: Literal["synthetic", "dataset"]
    input_tokens: int | None = Field(default=None, ge=1)
    output_tokens: int | None = Field(default=None, ge=1)
    dataset: str | None = Field(default=None, max_length=200)

    _strip = field_validator("name", "note")(strip_text)
    _not_blank = field_validator("name")(require_non_blank)

    @model_validator(mode="after")
    def _exactly_one_kind(self) -> "WorkloadCreate":
        if self.kind == "synthetic":
            if self.input_tokens is None or self.output_tokens is None:
                raise ValueError("a synthetic workload needs input_tokens and output_tokens")
            if self.dataset is not None:
                raise ValueError("a synthetic workload cannot name a dataset")
        else:
            if not self.dataset or not self.dataset.strip():
                raise ValueError("a dataset workload needs a dataset name")
            if self.input_tokens is not None or self.output_tokens is not None:
                raise ValueError("a dataset workload does not take token counts")
        return self


class WorkloadUpdate(BaseModel):
    """Only the label may change. The shape is frozen at creation — a
    Workload is a category, and a category whose contents drift makes every
    pairing that references it a lie. Unknown keys are an error rather than
    being dropped: silently discarding someone's ``input_tokens`` edit would
    leave them believing it took effect."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=200)
    note: str | None = Field(default=None, max_length=2000)

    _strip = field_validator("name", "note")(strip_text)
    _not_blank = field_validator("name")(require_non_blank)


def _positive_and_increasing(value: list[float]) -> list[float]:
    if any(level <= 0 for level in value):
        raise ValueError("levels must all be greater than zero")
    if list(value) != sorted(value) or len(set(value)) != len(value):
        raise ValueError("levels must be strictly increasing and unique")
    return value


def _whole_numbers(value: list[float]) -> list[float]:
    """Concurrency is a count of in-flight permits: a fractional level would
    execute as its truncation, measuring something other than what the Cell
    claims. QPS levels stay fractional — a rate can be 0.5."""
    if any(level != int(level) for level in value):
        raise ValueError("concurrency levels must be whole numbers")
    return value


def _valid_counts(value: list[int]) -> list[int]:
    if any(count < 1 or count > 100_000 for count in value):
        raise ValueError("num_requests must be between 1 and 100000")
    return value


class CellBatchCreate(BaseModel):
    """Configure Cells under a Deployment: one Workload, one mode, a ladder
    of levels, and one request count per level. A single count broadcasts to
    the whole ladder; several counts must pair with the levels one-to-one."""

    workload_id: int = Field(ge=1)
    mode: Literal["concurrency", "qps"]
    levels: list[float] = Field(min_length=1, max_length=64)
    num_requests: list[int] = Field(default=[64], min_length=1, max_length=64)

    _ladder = field_validator("levels")(_positive_and_increasing)
    _counts = field_validator("num_requests")(_valid_counts)

    @model_validator(mode="after")
    def _counts_broadcast_or_pair(self) -> "CellBatchCreate":
        if len(self.num_requests) not in (1, len(self.levels)):
            raise ValueError(
                f"num_requests has {len(self.num_requests)} value(s) but the ladder has "
                f"{len(self.levels)} level(s); give one count to broadcast, or one per level"
            )
        if self.mode == "concurrency":
            _whole_numbers(self.levels)
        return self

    def request_counts(self) -> list[int]:
        """One count per level: a single value broadcasts across the ladder."""
        if len(self.num_requests) == 1:
            return self.num_requests * len(self.levels)
        return self.num_requests


class SuiteCell(BaseModel):
    workload_id: int = Field(ge=1)
    mode: Literal["concurrency", "qps"]
    level: float = Field(gt=0, allow_inf_nan=False)
    num_requests: int = Field(ge=1, le=100_000)

    @model_validator(mode="after")
    def _valid_level(self) -> "SuiteCell":
        if self.mode == "concurrency" and not self.level.is_integer():
            raise ValueError("concurrency levels must be whole numbers")
        return self


class SuiteInput(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    note: str = Field(default="", max_length=2000)
    cells: list[SuiteCell] = Field(min_length=1, max_length=512)

    _strip = field_validator("name", "note")(strip_text)
    _not_blank = field_validator("name")(require_non_blank)

    @model_validator(mode="after")
    def _unique_cells(self) -> "SuiteInput":
        keys = [(cell.workload_id, cell.mode, cell.level) for cell in self.cells]
        if len(keys) != len(set(keys)):
            raise ValueError("a combination cannot contain duplicate workload/mode/level cells")
        return self


class CellUpdate(BaseModel):
    """``num_requests`` is the only adjustable parameter. Mode and level are
    identity — they sit in the uniqueness key, so changing them is
    delete-and-recreate, not an edit. Extra keys are an error: silently
    ignoring a ``level`` edit would leave the caller believing it took effect."""

    model_config = ConfigDict(extra="forbid")

    num_requests: int = Field(ge=1, le=100_000)


class CellsRunRequest(BaseModel):
    cell_ids: list[int] = Field(min_length=1)


class DeploymentUpdate(BaseModel):
    """A partial update: absent fields are left alone.

    ``None`` is a legitimate value for the nullable fields (clearing a
    context length), so routes distinguish absent from null by dumping with
    ``exclude_unset=True``.
    """

    name: str | None = Field(default=None, min_length=1, max_length=200)
    note: str | None = Field(default=None, max_length=2000)
    router_url: str | None = Field(default=None, min_length=1, max_length=500)
    model_name: str | None = Field(default=None, min_length=1, max_length=200)
    api_key_env: str | None = Field(default=None, max_length=200)
    context_length: int | None = Field(default=None, ge=1)
    synthetic_input_limit: int | None = Field(default=None, ge=1)
    gpu_model: str | None = Field(default=None, max_length=200)
    gpu_count: int | None = Field(default=None, ge=1)
    topology: str | None = Field(default=None, max_length=200)
    image: str | None = Field(default=None, max_length=500)

    _strip = field_validator("name", "note", "model_name", "gpu_model", "topology", "image")(strip_text)
    _not_blank = field_validator("name", "model_name", "router_url")(require_non_blank)
    _url = field_validator("router_url")(normalise_router_url)
    _env = field_validator("api_key_env")(require_env_var_name)
