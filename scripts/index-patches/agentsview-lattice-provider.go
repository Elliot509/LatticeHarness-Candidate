package parser

import (
	"context"
	"os"
	"path/filepath"
	"strings"
)

func newLatticeProviderFactory(def AgentDef) ProviderFactory {
	inner := NewSourceSetFactory(
		def,
		latticeProviderCapabilities(),
		func(cfg ProviderConfig) SourceSet {
			return newLatticeSourceSet(cfg.Roots)
		},
	)
	return latticeProviderFactory{ProviderFactory: inner}
}

// latticeProviderFactory keeps Lattice export snapshots out of the generic
// provider normalizer: unlike transcript agents, Lattice files are complete
// accounting snapshots whose session identity comes from file content, and
// whose reindex must replace the revision rather than append.
type latticeProviderFactory struct {
	ProviderFactory
}

func (f latticeProviderFactory) NewProvider(cfg ProviderConfig) Provider {
	provider := f.ProviderFactory.NewProvider(cfg).(*SourceSetProvider)
	return &latticeProvider{SourceSetProvider: provider}
}

type latticeProvider struct {
	*SourceSetProvider
}

func newLatticeSourceSet(roots []string) JSONLSourceSet {
	return NewJSONLSourceSet(AgentLattice, roots,
		WithRecursive(),
		WithExtensions(".jsonl"),
		WithIncludePath(isLatticeExportPath),
		WithSessionIDFromPath(latticeSessionIDFromPath),
		WithLookupIDValid(func(rawID string) bool {
			return strings.TrimSpace(rawID) != ""
		}),
		WithParseFile(latticeParseFile),
		WithForceReplace(),
	)
}

func latticeParseFile(
	ctx context.Context, path string, req ParseRequest,
) ([]ParseResult, []string, error) {
	session, events, err := parseLatticeExport(path)
	if err != nil {
		return nil, nil, err
	}
	info, statErr := os.Stat(path)
	file := FileInfo{Path: path}
	if statErr == nil {
		file.Size = info.Size()
		file.Mtime = info.ModTime().Unix()
	}
	if req.Fingerprint.Hash != "" {
		file.Hash = req.Fingerprint.Hash
	}
	session.File = file
	return []ParseResult{{
		Session:     session,
		UsageEvents: events,
	}}, nil, nil
}

// isLatticeExportPath accepts flat export snapshots: <anything>.jsonl files
// directly readable as Lattice exports. Content validation happens at parse
// time, where non-Lattice files fail loudly instead of being silently skipped.
func isLatticeExportPath(_root, path string) bool {
	return strings.EqualFold(filepath.Ext(path), ".jsonl")
}

func latticeSessionIDFromPath(_root, path string) string {
	base := filepath.Base(path)
	if !strings.HasSuffix(strings.ToLower(base), ".jsonl") {
		return ""
	}
	rawID := strings.TrimSuffix(base, filepath.Ext(base))
	if strings.TrimSpace(rawID) == "" {
		return ""
	}
	return rawID
}

func latticeProviderCapabilities() Capabilities {
	source := jsonlFileProviderSourceCapabilities()
	source.StreamingDiscovery = CapabilitySupported
	source.ForceReplaceOnParse = CapabilitySupported
	return Capabilities{
		Source: source,
		Content: ContentCapabilities{
			Model:                CapabilitySupported,
			AggregateUsageEvents: CapabilitySupported,
		},
	}
}
