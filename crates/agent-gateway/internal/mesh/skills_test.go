package mesh

import "testing"

func TestServesSkillHonoursAllowlist(t *testing.T) {
	all := DefaultConfig()
	for _, id := range BuiltinSkillIDs() {
		if !all.servesSkill(id) {
			t.Errorf("an empty allowlist must serve %q", id)
		}
	}

	restricted := DefaultConfig()
	restricted.SkillAllowlist = []string{SkillPing}
	if !restricted.servesSkill(SkillPing) {
		t.Error("an allowlisted skill must be served")
	}
	for _, id := range []string{SkillDescribe, SkillStatus} {
		if restricted.servesSkill(id) {
			t.Errorf("%q is not in the allowlist and must not be served", id)
		}
	}

	// Whitespace in a comma-separated setting must not silently disable a skill.
	padded := DefaultConfig()
	padded.SkillAllowlist = []string{"  " + SkillStatus + "  "}
	if !padded.servesSkill(SkillStatus) {
		t.Error("surrounding whitespace must be tolerated in a skill id")
	}
}

func TestBuiltinSkillIDsIsACopy(t *testing.T) {
	first := BuiltinSkillIDs()
	if len(first) == 0 {
		t.Fatal("expected at least one built-in skill")
	}
	first[0] = "mutated"
	if BuiltinSkillIDs()[0] == "mutated" {
		t.Fatal("BuiltinSkillIDs must not expose the package's own slice")
	}
}

func TestConfigRejectsUnknownSkillInAllowlist(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.URL = "nats://localhost:4222"
	cfg.SkillAllowlist = []string{SkillPing, "pigng"} // typo
	if err := cfg.Validate(); err == nil {
		t.Fatal("an unknown skill id must be rejected rather than silently unserved")
	}
}

func TestConfigAcceptsKnownSkillAllowlist(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.URL = "nats://localhost:4222"
	cfg.SkillAllowlist = []string{SkillPing, SkillStatus}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("a known allowlist must validate: %v", err)
	}
}

func TestSkillsAreEnabledByDefault(t *testing.T) {
	if !DefaultConfig().SkillsEnabled {
		t.Fatal("skills should be served by default; the bridge itself is off by default")
	}
}
