"""Incremental Server-Sent Events parsing.

Bytes in, events out. Pure — never touches the network.

The rule that matters: a network chunk is not a line, and a line is not an
event. Code that assumes either passes casual testing and then quietly
corrupts timings against a real server.
"""

from __future__ import annotations

import codecs
from dataclasses import dataclass


@dataclass(frozen=True)
class SSEEvent:
    """One dispatched SSE event."""

    data: str
    event: str | None = None
    id: str | None = None


class SSEParser:
    """Feed bytes, get events. Stateful across chunks.

    A trailing CR at the end of a chunk is held back, because it may be the
    first half of CRLF and dispatching a line early would split an event.
    """

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")()
        self._buffer = ""
        self._data_lines: list[str] = []
        self._event_type: str | None = None
        self._event_id: str | None = None
        self._closed = False

    def feed(self, chunk: bytes) -> list[SSEEvent]:
        """Decode and parse one network chunk. Returns any events it completed."""
        if self._closed:
            raise RuntimeError("feed() called after close()")
        events: list[SSEEvent] = []
        self._buffer += self._decoder.decode(chunk)
        self._consume_lines(events, final=False)
        return events

    def close(self) -> list[SSEEvent]:
        """Flush the decoder and any trailing partial line or event."""
        if self._closed:
            return []
        self._closed = True
        events: list[SSEEvent] = []
        self._buffer += self._decoder.decode(b"", final=True)
        self._consume_lines(events, final=True)
        self._dispatch(events)
        return events

    def _consume_lines(self, events: list[SSEEvent], *, final: bool) -> None:
        while True:
            cut = self._find_line_end(final=final)
            if cut is None:
                return
            index, width = cut
            line = self._buffer[:index]
            self._buffer = self._buffer[index + width :]
            self._handle_line(line, events)

    def _find_line_end(self, *, final: bool) -> tuple[int, int] | None:
        for i, ch in enumerate(self._buffer):
            if ch == "\n":
                return i, 1
            if ch == "\r":
                if i + 1 < len(self._buffer):
                    return (i, 2) if self._buffer[i + 1] == "\n" else (i, 1)
                return (i, 1) if final else None
        return None

    def _handle_line(self, line: str, events: list[SSEEvent]) -> None:
        if line == "":
            self._dispatch(events)
            return
        if line.startswith(":"):
            return  # comment
        field, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if field == "data":
            self._data_lines.append(value)
        elif field == "event":
            self._event_type = value
        elif field == "id":
            self._event_id = value
        # "retry" and unknown fields are ignored, as the spec allows.

    def _dispatch(self, events: list[SSEEvent]) -> None:
        if not self._data_lines:
            # An event whose data buffer is empty is not dispatched; the event
            # type is still cleared so it cannot leak into the next event.
            self._event_type = None
            return
        events.append(
            SSEEvent(
                data="\n".join(self._data_lines),
                event=self._event_type,
                id=self._event_id,
            )
        )
        self._data_lines = []
        self._event_type = None
