package parser

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeLatticeFixture(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func latticeAttempt(attempt, model, finished string, input, output int, revision int) string {
	return `{"recordType":"attempt_usage","canonicalDay":null,"usage":` +
		`{"schemaVersion":1,"sessionId":"session-1","runId":"run-1","taskId":"task-1",` +
		`"rootId":"root-1","requestId":"req-1","attemptId":"` + attempt + `",` +
		`"parentAttemptId":null,"intentId":"intent-1","executorGeneration":1,` +
		`"provider":"fake","modelRequested":"` + model + `","modelResolved":"` + model + `",` +
		`"adapterRevision":"fake-1","usageRevision":` + latticeItoa(revision) + `,"usageFinal":true,` +
		`"purpose":"primary","status":"completed",` +
		`"admittedAt":"2026-09-11T10:00:00Z","dispatchedAt":"2026-09-11T10:00:01Z",` +
		`"firstTokenAt":null,"finishedAt":"` + finished + `","recordedAt":"2026-09-11T10:00:03Z",` +
		`"clockQuality":"wall","durationMs":1000,"providerRequestId":null,"error":null,` +
		`"inputTotal":{"value":` + latticeItoa(input) + `,"quality":"observed","source":"s"},` +
		`"inputNew":{"value":` + latticeItoa(input) + `,"quality":"observed","source":"s"},` +
		`"cacheRead":{"value":0,"quality":"observed","source":"s"},` +
		`"cacheWrite":{"value":0,"quality":"observed","source":"s"},` +
		`"outputTotal":{"value":` + latticeItoa(output) + `,"quality":"observed","source":"s"},` +
		`"reasoningSubset":null}}`
}

func latticeItoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	if neg {
		return "-" + string(digits)
	}
	return string(digits)
}

func latticeHeader(session string) string {
	return `{"schemaVersion":1,"recordType":"session","sessionId":"` + session + `",` +
		`"rootId":"root-1","createdAt":"2026-09-11T09:00:00Z","exportedAt":"2026-09-11T11:00:00Z",` +
		`"ledgerCut":10,"exportRevision":1,"producer":"Lattice","packageVersion":"0.0.0",` +
		`"usageCoverage":{"attempts":2,"observed":2,"estimated":0,"unknown":0,` +
		`"knownInputTotal":300,"knownOutputTotal":60},"timezone":"UTC"}`
}

func latticeComplete(session string, count int) string {
	return `{"recordType":"export_complete","sessionId":"` + session + `",` +
		`"recordCount":` + latticeItoa(count) + `,"ledgerCut":10}`
}

func TestParseLatticeExportValid(t *testing.T) {
	content := strings.Join([]string{
		latticeHeader("session-1"),
		// Attempt crossing midnight UTC: finished on the 12th.
		latticeAttempt("attempt-1", "fake-model-1", "2026-09-11T23:59:59Z", 100, 20, 1),
		latticeAttempt("attempt-2", "fake-model-1", "2026-09-12T00:00:01Z", 200, 40, 1),
		latticeComplete("session-1", 2),
	}, "\n") + "\n"
	path := writeLatticeFixture(t, "session-1.jsonl", content)
	session, events, err := parseLatticeExport(path)
	if err != nil {
		t.Fatalf("parseLatticeExport: %v", err)
	}
	if session.ID != "lattice:session-1" {
		t.Fatalf("session ID = %q", session.ID)
	}
	if session.Agent != AgentLattice {
		t.Fatalf("agent = %q", session.Agent)
	}
	if len(events) != 2 {
		t.Fatalf("events = %d, want 2", len(events))
	}
	if events[0].Model != "fake-model-1" || events[0].InputTokens != 100 || events[0].OutputTokens != 20 {
		t.Fatalf("event 0 = %+v", events[0])
	}
	if events[0].DedupKey != "lattice:attempt-1:rev1" {
		t.Fatalf("dedup 0 = %q", events[0].DedupKey)
	}
	// UTC day attribution comes from finishedAt, not from the export day.
	if !strings.HasPrefix(events[0].OccurredAt, "2026-09-11") {
		t.Fatalf("event 0 occurred = %q", events[0].OccurredAt)
	}
	if !strings.HasPrefix(events[1].OccurredAt, "2026-09-12") {
		t.Fatalf("event 1 occurred = %q", events[1].OccurredAt)
	}
}

func TestParseLatticeExportRejectsPartial(t *testing.T) {
	content := strings.Join([]string{
		latticeHeader("session-1"),
		latticeAttempt("attempt-1", "fake-model-1", "2026-09-11T10:00:02Z", 100, 20, 1),
	}, "\n") + "\n"
	path := writeLatticeFixture(t, "partial.jsonl", content)
	if _, _, err := parseLatticeExport(path); err == nil {
		t.Fatal("partial snapshot without terminator must fail")
	}
}

func TestParseLatticeExportRejectsForeignProducer(t *testing.T) {
	header := strings.Replace(latticeHeader("session-1"), `"producer":"Lattice"`, `"producer":"Claude"`, 1)
	content := strings.Join([]string{
		header,
		latticeAttempt("attempt-1", "fake-model-1", "2026-09-11T10:00:02Z", 100, 20, 1),
		latticeComplete("session-1", 1),
	}, "\n") + "\n"
	path := writeLatticeFixture(t, "foreign.jsonl", content)
	if _, _, err := parseLatticeExport(path); err == nil {
		t.Fatal("non-Lattice producer must fail")
	}
}

func TestParseLatticeExportRejectsUnknownUsage(t *testing.T) {
	line := strings.Replace(
		latticeAttempt("attempt-1", "fake-model-1", "2026-09-11T10:00:02Z", 100, 20, 1),
		`"outputTotal":{"value":20,"quality":"observed","source":"s"}`,
		`"outputTotal":{"value":null,"quality":"unknown","source":"s"}`,
		1,
	)
	content := strings.Join([]string{
		latticeHeader("session-1"),
		line,
		latticeComplete("session-1", 1),
	}, "\n") + "\n"
	path := writeLatticeFixture(t, "unknown.jsonl", content)
	if _, _, err := parseLatticeExport(path); err == nil {
		t.Fatal("unknown usage must fail instead of publishing zero")
	}
}

func TestParseLatticeExportRejectsCountMismatch(t *testing.T) {
	content := strings.Join([]string{
		latticeHeader("session-1"),
		latticeAttempt("attempt-1", "fake-model-1", "2026-09-11T10:00:02Z", 100, 20, 1),
		latticeComplete("session-1", 2),
	}, "\n") + "\n"
	path := writeLatticeFixture(t, "mismatch.jsonl", content)
	if _, _, err := parseLatticeExport(path); err == nil {
		t.Fatal("terminator count mismatch must fail")
	}
}

func TestParseLatticeExportRejectsMissingModel(t *testing.T) {
	line := strings.Replace(
		latticeAttempt("attempt-1", "fake-model-1", "2026-09-11T10:00:02Z", 100, 20, 1),
		`"modelRequested":"fake-model-1","modelResolved":"fake-model-1"`,
		`"modelRequested":"","modelResolved":null`,
		1,
	)
	content := strings.Join([]string{
		latticeHeader("session-1"),
		line,
		latticeComplete("session-1", 1),
	}, "\n") + "\n"
	path := writeLatticeFixture(t, "nomodel.jsonl", content)
	if _, _, err := parseLatticeExport(path); err == nil {
		t.Fatal("model-less attempt must fail instead of shipping unattributed usage")
	}
}
