package parser

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

const latticeSessionPrefix = "lattice:"

// latticeQuantity mirrors the Lattice ledger's typed quantity: a null value
// means unknown, never zero.
type latticeQuantity struct {
	Value   *int64 `json:"value"`
	Quality string `json:"quality"`
}

func (q latticeQuantity) observed() (int64, bool) {
	if q.Value == nil {
		return 0, false
	}
	if q.Quality != "observed" && q.Quality != "estimated" {
		return 0, false
	}
	return *q.Value, true
}

type latticeUsage struct {
	AttemptID      string           `json:"attemptId"`
	UsageRevision  int              `json:"usageRevision"`
	ModelRequested string           `json:"modelRequested"`
	ModelResolved  *string          `json:"modelResolved"`
	UsageFinal     bool             `json:"usageFinal"`
	FinishedAt     *string          `json:"finishedAt"`
	InputTotal     latticeQuantity  `json:"inputTotal"`
	OutputTotal    latticeQuantity  `json:"outputTotal"`
	CacheRead      latticeQuantity  `json:"cacheRead"`
	CacheWrite     latticeQuantity  `json:"cacheWrite"`
	Reasoning      *latticeQuantity `json:"reasoningSubset"`
}

type latticeAttemptLine struct {
	RecordType string       `json:"recordType"`
	Usage      latticeUsage `json:"usage"`
}

type latticeSessionLine struct {
	RecordType    string `json:"recordType"`
	SchemaVersion int    `json:"schemaVersion"`
	Producer      string `json:"producer"`
	SessionID     string `json:"sessionId"`
	RootID        string `json:"rootId"`
	CreatedAt     string `json:"createdAt"`
	ExportedAt    string `json:"exportedAt"`
}

type latticeCompleteLine struct {
	RecordType  string `json:"recordType"`
	SessionID   string `json:"sessionId"`
	RecordCount int    `json:"recordCount"`
}

func parseLatticeTime(value string, what string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		parsed, err = time.Parse(time.RFC3339, value)
	}
	if err != nil {
		return time.Time{}, fmt.Errorf("lattice: invalid %s timestamp %q", what, value)
	}
	return parsed.UTC(), nil
}

// parseLatticeExport reads one Lattice export snapshot and returns the
// session plus one usage event per fully-observed attempt. Any structural
// problem or coverage gap is an error: Lattice accounting must never degrade
// into partial totals.
func parseLatticeExport(path string) (ParsedSession, []ParsedUsageEvent, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return ParsedSession{}, nil, fmt.Errorf("lattice: read export: %w", err)
	}
	lines := make([]string, 0)
	for _, raw := range strings.Split(string(data), "\n") {
		if trimmed := strings.TrimSpace(raw); trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	if len(lines) < 2 {
		return ParsedSession{}, nil, fmt.Errorf("lattice: %s: snapshot needs a session line and a terminator", path)
	}
	var header latticeSessionLine
	if err := json.Unmarshal([]byte(lines[0]), &header); err != nil {
		return ParsedSession{}, nil, fmt.Errorf("lattice: %s: invalid session line: %w", path, err)
	}
	if header.RecordType != "session" {
		return ParsedSession{}, nil, fmt.Errorf("lattice: %s: first line is not a session header", path)
	}
	if header.Producer != "Lattice" {
		return ParsedSession{}, nil, fmt.Errorf("lattice: %s: producer %q is not Lattice", path, header.Producer)
	}
	if header.SchemaVersion != 1 {
		return ParsedSession{}, nil, fmt.Errorf("lattice: %s: unsupported schemaVersion %d", path, header.SchemaVersion)
	}
	if header.SessionID == "" {
		return ParsedSession{}, nil, fmt.Errorf("lattice: %s: session header without sessionId", path)
	}
	var complete latticeCompleteLine
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &complete); err != nil {
		return ParsedSession{}, nil, fmt.Errorf("lattice: %s: invalid terminator: %w", path, err)
	}
	if complete.RecordType != "export_complete" {
		return ParsedSession{}, nil, fmt.Errorf("lattice: %s: missing export_complete terminator; refusing a partial snapshot", path)
	}
	if complete.SessionID != header.SessionID {
		return ParsedSession{}, nil, fmt.Errorf("lattice: %s: terminator session %q does not match header %q", path, complete.SessionID, header.SessionID)
	}
	attemptLines := lines[1 : len(lines)-1]
	if complete.RecordCount != len(attemptLines) {
		return ParsedSession{}, nil, fmt.Errorf("lattice: %s: terminator counts %d records but %d found", path, complete.RecordCount, len(attemptLines))
	}
	createdAt, err := parseLatticeTime(header.CreatedAt, "createdAt")
	if err != nil {
		return ParsedSession{}, nil, err
	}
	exportedAt, err := parseLatticeTime(header.ExportedAt, "exportedAt")
	if err != nil {
		return ParsedSession{}, nil, err
	}
	sessionID := latticeSessionPrefix + header.SessionID
	events := make([]ParsedUsageEvent, 0, len(attemptLines))
	for index, line := range attemptLines {
		var parsed latticeAttemptLine
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			return ParsedSession{}, nil, fmt.Errorf("lattice: %s: invalid attempt_usage line %d: %w", path, index, err)
		}
		if parsed.RecordType != "attempt_usage" {
			return ParsedSession{}, nil, fmt.Errorf("lattice: %s: line %d is not an attempt_usage record", path, index)
		}
		event, err := latticeUsageEvent(sessionID, parsed.Usage)
		if err != nil {
			return ParsedSession{}, nil, fmt.Errorf("lattice: %s: line %d: %w", path, index, err)
		}
		events = append(events, event)
	}
	session := ParsedSession{
		ID:        sessionID,
		Agent:     AgentLattice,
		StartedAt: createdAt,
		EndedAt:   exportedAt,
	}
	return session, events, nil
}

func latticeUsageEvent(sessionID string, usage latticeUsage) (ParsedUsageEvent, error) {
	if usage.AttemptID == "" {
		return ParsedUsageEvent{}, fmt.Errorf("attempt without attemptId")
	}
	model := ""
	if usage.ModelResolved != nil {
		model = *usage.ModelResolved
	}
	if model == "" {
		model = usage.ModelRequested
	}
	if model == "" {
		return ParsedUsageEvent{}, fmt.Errorf("attempt %s has no model; refusing unattributed usage", usage.AttemptID)
	}
	if usage.FinishedAt == nil || *usage.FinishedAt == "" {
		return ParsedUsageEvent{}, fmt.Errorf("attempt %s has no end timestamp; refusing a pending attempt", usage.AttemptID)
	}
	finishedAt, err := parseLatticeTime(*usage.FinishedAt, "finishedAt")
	if err != nil {
		return ParsedUsageEvent{}, fmt.Errorf("attempt %s: %w", usage.AttemptID, err)
	}
	input, ok := usage.InputTotal.observed()
	if !ok {
		return ParsedUsageEvent{}, fmt.Errorf("attempt %s has unknown input total; refusing to publish zero", usage.AttemptID)
	}
	output, ok := usage.OutputTotal.observed()
	if !ok {
		return ParsedUsageEvent{}, fmt.Errorf("attempt %s has unknown output total; refusing to publish zero", usage.AttemptID)
	}
	var cacheRead, cacheWrite, reasoning int64
	if value, ok := usage.CacheRead.observed(); ok {
		cacheRead = value
	} else if usage.CacheRead.Value != nil {
		return ParsedUsageEvent{}, fmt.Errorf("attempt %s has an unusable cache-read partition", usage.AttemptID)
	}
	if value, ok := usage.CacheWrite.observed(); ok {
		cacheWrite = value
	} else if usage.CacheWrite.Value != nil {
		return ParsedUsageEvent{}, fmt.Errorf("attempt %s has an unusable cache-write partition", usage.AttemptID)
	}
	if usage.Reasoning != nil {
		if value, ok := usage.Reasoning.observed(); ok {
			reasoning = value
		} else if usage.Reasoning.Value != nil {
			return ParsedUsageEvent{}, fmt.Errorf("attempt %s has an unusable reasoning partition", usage.AttemptID)
		}
	}
	return ParsedUsageEvent{
		SessionID:                sessionID,
		Source:                   "lattice",
		Model:                    model,
		InputTokens:              int(input),
		OutputTokens:             int(output),
		CacheCreationInputTokens: int(cacheWrite),
		CacheReadInputTokens:     int(cacheRead),
		ReasoningTokens:          int(reasoning),
		OccurredAt:               finishedAt.Format(time.RFC3339Nano),
		DedupKey: fmt.Sprintf(
			"lattice:%s:rev%d",
			usage.AttemptID, usage.UsageRevision,
		),
	}, nil
}
