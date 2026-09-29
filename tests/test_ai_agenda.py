"""La IA de la agenda: su respuesta se revisa y, si viene rara, no rompe nada (se pregunta)."""

import datetime as dt

import pytest
from pydantic import ValidationError

from app import ai, clock
from app.agenda import EventDraft

TODAY = clock.today()


def _draft(**kw):
    base = {"ok": True, "title": "Llamar a la abuela", "category": "familia", "member": None,
            "date": "", "time": None, "repeat": "none"}
    return EventDraft(**{**base, **kw})


def _say(client, text):
    return client.post("/api/voice", json={"text": text, "context": {}}).json()


def _ai_returns(monkeypatch, draft):
    monkeypatch.setattr(ai, "text_parse", lambda model, prompt, schema, fast=False: draft)


def test_ai_without_date_asks_instead_of_inventing(client, monkeypatch):
    _ai_returns(monkeypatch, _draft(date=""))
    r = _say(client, "recuérdame lo de la abuela")
    assert r["intent"] == "agenda_ask" and r["data"]["pending"]["need"] == "day"


def test_ai_past_or_broken_values_are_asked(client, monkeypatch):
    _ai_returns(monkeypatch, _draft(date=(TODAY - dt.timedelta(days=3)).isoformat()))
    assert _say(client, "recuérdame lo de la abuela")["data"]["pending"]["need"] == "day"

    _ai_returns(monkeypatch, _draft(date="el jueves"))  # no es una fecha
    assert _say(client, "recuérdame lo de la abuela")["data"]["pending"]["need"] == "day"

    _ai_returns(monkeypatch, _draft(date=TODAY.isoformat(), time="25:99"))  # hora imposible: se pregunta
    assert _say(client, "recuérdame lo de la abuela")["data"]["pending"]["need"] == "time"


def test_ai_good_answer_and_member_without_accents(client, monkeypatch):
    client.post("/api/members", json={"name": "Sofía"})
    day = (TODAY + dt.timedelta(days=1)).isoformat()
    _ai_returns(monkeypatch, _draft(title="cita con la pediatra", category="salud", member="sofia", date=day, time="09:30"))
    r = _say(client, "recuérdame lo de la pediatra de la niña")
    assert r["intent"] == "agenda_add"
    assert (r["data"]["title"], r["data"]["date"], r["data"]["time"]) == ("Cita con la pediatra", day, "09:30")
    [ev] = client.get("/api/events").json()
    assert ev["member_id"] is not None and ev["category"] == "salud"


def test_ai_errors_do_not_break_the_voice(client, monkeypatch):
    def boom(model, prompt, schema, fast=False):
        raise ai.AIError("OpenAI no dio una respuesta válida.", 422)
    monkeypatch.setattr(ai, "text_parse", boom)
    r = _say(client, "recuérdame lo de la abuela")
    assert r["intent"] == "agenda_ask"  # sin IA, igual pregunta el día


def test_schema_only_allows_known_values():
    with pytest.raises(ValidationError):
        _draft(category="trabajo")
    with pytest.raises(ValidationError):
        _draft(repeat="daily")


class _FakeResponses:
    def __init__(self, result=None, error=None):
        self.result, self.error = result, error

    def parse(self, **kw):
        if self.error:
            raise self.error
        return self.result


def _fake_openai(monkeypatch, **kw):
    class Client:
        def __init__(self, api_key):
            self.responses = _FakeResponses(**kw)
    monkeypatch.setattr(ai, "openai_key", lambda: "sk-test")
    monkeypatch.setattr(ai.openai, "OpenAI", Client)


def test_openai_parse_turns_bad_output_into_ai_error(monkeypatch):
    try:
        EventDraft.model_validate({"ok": True})
    except ValidationError as e:
        bad = e
    for error in (bad, ValueError("JSON cortado")):
        _fake_openai(monkeypatch, error=error)
        with pytest.raises(ai.AIError) as exc:
            ai.openai_parse("gpt", "hola", EventDraft)
        assert exc.value.status == 422

    class Refused:
        output_parsed = None
    _fake_openai(monkeypatch, result=Refused())
    with pytest.raises(ai.AIError):
        ai.openai_parse("gpt", "hola", EventDraft)

    class Ok:
        output_parsed = _draft()
    _fake_openai(monkeypatch, result=Ok())
    assert ai.openai_parse("gpt", "hola", EventDraft).title == "Llamar a la abuela"
