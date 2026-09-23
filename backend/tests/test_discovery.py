"""Reading the context length out of ``/v1/models``.

The rule that matters: fail rather than guess. A wrong context length silently
builds the whole workload catalogue against the wrong budget, and every number
after it is subtly off — which this project treats as its worst failure mode.
"""

from __future__ import annotations

import pytest

from llmbench.discovery import DiscoveryError, parse_context_length

DEEPSEEK = {
    "object": "list",
    "data": [
        {
            "id": "DeepSeek-V4-Flash-0731",
            "object": "model",
            "owned_by": "sglang",
            "max_model_len": 1048576,
        }
    ],
}


def test_the_named_models_context_length_is_used():
    assert parse_context_length(DEEPSEEK, "DeepSeek-V4-Flash-0731") == 1048576


def test_a_unique_advertised_value_is_accepted_for_another_entry():
    """SGLang puts the context length on the base card; a LoRA card may omit it."""
    payload = {
        "data": [
            {"id": "base", "max_model_len": 32768},
            {"id": "lora-adapter"},
        ]
    }
    assert parse_context_length(payload, "lora-adapter") == 32768


def test_the_named_entry_wins_over_the_others():
    payload = {
        "data": [
            {"id": "base", "max_model_len": 32768},
            {"id": "long", "max_model_len": 131072},
        ]
    }
    assert parse_context_length(payload, "long") == 131072


def test_several_advertised_values_without_a_match_is_refused():
    payload = {
        "data": [
            {"id": "a", "max_model_len": 32768},
            {"id": "b", "max_model_len": 131072},
        ]
    }
    with pytest.raises(DiscoveryError, match="several context lengths"):
        parse_context_length(payload, "unknown")


def test_no_advertised_value_is_refused_rather_than_guessed():
    with pytest.raises(DiscoveryError, match="does not advertise"):
        parse_context_length({"data": [{"id": "m"}]}, "m")


@pytest.mark.parametrize("body", [{}, {"data": []}, {"data": "nope"}, None, [1, 2]])
def test_a_body_with_no_usable_model_list_is_refused(body):
    with pytest.raises(DiscoveryError):
        parse_context_length(body, "m")


@pytest.mark.parametrize("value", [0, -1, "1048576", 1.5, None])
def test_a_non_positive_or_non_integer_length_is_not_advertised(value):
    with pytest.raises(DiscoveryError):
        parse_context_length({"data": [{"id": "m", "max_model_len": value}]}, "m")
