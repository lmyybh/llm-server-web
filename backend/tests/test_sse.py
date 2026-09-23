"""The SSE parser, tested at its own boundary.

A network chunk is not a line and a line is not an event. Every test here
picks a different place to cut the byte stream, because the failures this
guards against only show up when the cut lands somewhere inconvenient.
"""

from __future__ import annotations

import json

import pytest

from llmbench.sse import SSEParser


def parse(chunks: list[bytes]) -> list:
    parser = SSEParser()
    events = []
    for chunk in chunks:
        events.extend(parser.feed(chunk))
    events.extend(parser.close())
    return events


def test_single_event_in_a_single_chunk():
    events = parse([b"data: hello\n\n"])
    assert [e.data for e in events] == ["hello"]


def test_event_split_across_chunks():
    events = parse([b"da", b"ta: hel", b"lo\n", b"\n"])
    assert [e.data for e in events] == ["hello"]


def test_several_events_in_one_chunk():
    events = parse([b"data: one\n\ndata: two\n\ndata: three\n\n"])
    assert [e.data for e in events] == ["one", "two", "three"]


def test_utf8_split_mid_character():
    """A multi-byte character cut in half must not become two replacement chars."""
    payload = json.dumps({"content": "你好世界"}, ensure_ascii=False).encode("utf-8")
    message = b"data: " + payload + b"\n\n"
    for cut in range(1, len(message)):
        events = parse([message[:cut], message[cut:]])
        assert [json.loads(e.data) for e in events] == [{"content": "你好世界"}], f"cut at {cut}"


def test_multiline_data_is_joined_with_newline():
    events = parse([b"data: line one\ndata: line two\n\n"])
    assert [e.data for e in events] == ["line one\nline two"]


def test_done_sentinel_passes_through_verbatim():
    events = parse([b"data: [DONE]\n\n"])
    assert [e.data for e in events] == ["[DONE]"]


def test_comment_lines_are_ignored():
    events = parse([b": keep-alive\n\ndata: real\n\n"])
    assert [e.data for e in events] == ["real"]


def test_blank_line_without_a_data_field_dispatches_nothing():
    events = parse([b"\n\n\n", b"event: ping\n\n"])
    assert events == []


def test_crlf_line_endings():
    events = parse([b"data: hello\r\n\r\n"])
    assert [e.data for e in events] == ["hello"]


def test_trailing_cr_is_held_back_until_the_next_chunk_decides():
    """CR at the end of a chunk may be the first half of CRLF."""
    parser = SSEParser()
    assert parser.feed(b"data: hello\r") == []
    assert [e.data for e in parser.feed(b"\n\r\n")] == ["hello"]


def test_lone_cr_terminates_a_line():
    events = parse([b"data: hello\r\r"])
    assert [e.data for e in events] == ["hello"]


def test_event_type_and_id_are_captured():
    events = parse([b"event: delta\nid: 42\ndata: x\n\n"])
    assert len(events) == 1
    assert events[0].event == "delta"
    assert events[0].id == "42"
    assert events[0].data == "x"


def test_event_type_does_not_leak_into_a_data_only_event():
    events = parse([b"event: delta\n\n", b"data: plain\n\n"])
    assert [e.event for e in events] == [None]


def test_space_after_colon_is_stripped_once_only():
    events = parse([b"data:  two spaces\n\n"])
    assert [e.data for e in events] == [" two spaces"]


def test_field_without_a_colon_is_treated_as_having_an_empty_value():
    events = parse([b"data:\n\ndata:x\n\n"])
    assert [e.data for e in events] == ["", "x"]


def test_a_complete_final_line_is_processed_even_without_a_blank_line():
    events = parse([b"data: complete\n"])
    assert [e.data for e in events] == ["complete"]


def test_an_unterminated_trailing_event_is_discarded_not_half_parsed():
    """A stream cut mid-event must not hand the caller a truncated payload.

    Discarding turns it into a visible "stream ended without [DONE]"; parsing
    it would either fail confusingly or, worse, succeed on partial JSON.
    """
    assert parse([b"data: unterminated"]) == []
    assert parse([b'data: {"choices":[{"tex']) == []


def test_feed_after_close_is_an_error():
    parser = SSEParser()
    parser.close()
    with pytest.raises(RuntimeError):
        parser.feed(b"data: late\n\n")


def test_real_sglang_stream_reassembles_identically_whatever_the_chunking():
    """Take the stream a live server produced and cut it everywhere."""
    stream = (
        b'data: {"id":"a","choices":[{"index":0,"delta":{"reasoning_content":null,"content":""}}]}\n\n'
        b'data: {"id":"a","choices":[{"index":0,"delta":{"content":"p"}}],'
        b'"usage":{"prompt_tokens":9,"completion_tokens":1}}\n\n'
        b'data: {"id":"a","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3}}\n\n'
        b"data: [DONE]\n\n"
    )
    reference = [e.data for e in parse([stream])]
    assert len(reference) == 4

    for chunk_size in (1, 2, 3, 7, 13, 64):
        chunks = [stream[i : i + chunk_size] for i in range(0, len(stream), chunk_size)]
        assert [e.data for e in parse(chunks)] == reference, f"chunk size {chunk_size}"
