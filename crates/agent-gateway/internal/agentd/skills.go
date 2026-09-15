package agentd

// The skills library: a read-only window onto a directory of SKILL.md
// collections (the operator's skill library, e.g. ~/.agents/skills). Skills
// are exposure, not execution: the agentd lists them in its system prompt and
// serves their files through two confined tools, and the model decides what
// to do with the instructions — the same relationship a person has with a
// runbook shelf.
//
// Deliberately read-only: a skill can instruct the model to run commands, but
// those go through the sandboxed shell tool like any other command — the
// library itself cannot be written to by a turn.

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// skillFile is the conventional name of a skill's instructions.
const skillFile = "SKILL.md"

// skillOutputCap bounds one served skill file — a skill is instructions, not
// a bulk data channel.
const skillOutputCap = 128 << 10

// Skill is one scanned entry of the library.
type Skill struct {
	// Name is the frontmatter's name (or the directory's, absent frontmatter).
	Name string
	// Description is the frontmatter description, for the prompt listing.
	Description string
	// Dir is the skill's directory, the confinement root for its files.
	Dir string
}

// LoadSkills scans dir for <name>/SKILL.md collections and parses their
// frontmatter (name, description). Skills without frontmatter keep their
// directory name. The result is sorted by name — the prompt listing and the
// served set must be stable, because the tools refuse anything that was not
// scanned.
func LoadSkills(dir string) ([]Skill, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return nil, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read skills directory: %v", err)
	}
	var skills []Skill
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		skillDir := filepath.Join(dir, entry.Name())
		markdown, err := os.ReadFile(filepath.Join(skillDir, skillFile))
		if err != nil {
			continue // not a skill directory; the library may hold other things
		}
		name, description := parseSkillFrontmatter(string(markdown))
		if name == "" {
			name = entry.Name()
		}
		if description == "" {
			description = "(no description)"
		}
		skills = append(skills, Skill{Name: name, Description: description, Dir: skillDir})
	}
	sort.Slice(skills, func(i, j int) bool { return skills[i].Name < skills[j].Name })
	return skills, nil
}

// parseSkillFrontmatter reads the YAML frontmatter block for name and
// description. Deliberately dependency-free: the frontmatter's first two keys
// are all the prompt needs, and a full YAML parser for that would be weight
// without honesty.
func parseSkillFrontmatter(markdown string) (name, description string) {
	lines := strings.Split(markdown, "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return "", ""
	}
	var lastKey string
	for _, line := range lines[1:] {
		trimmed := strings.TrimSpace(line)
		if trimmed == "---" {
			break
		}
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
			// A continuation of the previous value (YAML folded scalars).
			switch lastKey {
			case "description":
				description = joinValue(description, trimmed)
			case "name":
				name = joinValue(name, trimmed)
			}
			continue
		}
		key, value, found := strings.Cut(trimmed, ":")
		if !found {
			lastKey = ""
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		// Strip one layer of quotes; a folding indicator (>, |) means the
		// value continues on following indented lines.
		value = strings.Trim(value, "\"'")
		switch key {
		case "name":
			if value != "" && value != ">" && value != "|" && !strings.HasSuffix(value, "-") {
				name = value
			}
			lastKey = "name"
		case "description":
			if value != "" && value != ">" && value != "|" && !strings.HasSuffix(value, "-") {
				description = value
			}
			lastKey = "description"
		default:
			lastKey = ""
		}
	}
	return name, description
}

func joinValue(existing, addition string) string {
	if existing == "" {
		return addition
	}
	return existing + " " + addition
}

// PromptSection renders the library for the system prompt: names plus
// descriptions, capped so a large shelf does not eat the context window.
func PromptSection(skills []Skill) string {
	if len(skills) == 0 {
		return ""
	}
	var builder strings.Builder
	builder.WriteString("\n\n## Skills\n\n")
	builder.WriteString("A library of skills is available. Before performing a task that matches one, ")
	builder.WriteString("load it with the read_skill tool and follow its instructions. ")
	builder.WriteString("Available skills:\n")
	for _, skill := range skills {
		line := fmt.Sprintf("- %s: %s", skill.Name, oneLine(skill.Description, 240))
		builder.WriteString(line)
		builder.WriteString("\n")
	}
	return builder.String()
}
