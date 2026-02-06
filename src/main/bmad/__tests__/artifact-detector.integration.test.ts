import * as fs from 'fs/promises';
import * as path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ArtifactDetector } from '../artifact-detector';

/**
 * Integration tests for ArtifactDetector cross-session persistence
 * These tests validate that artifact detection works correctly when:
 * - App restarts and re-scans _bmad-output directory
 * - Artifacts persist across sessions
 * - State is reconstructed from file system
 */
describe('ArtifactDetector - Cross-Session Persistence Integration', () => {
  let detector: ArtifactDetector;
  let testProjectRoot: string;
  let testOutputDir: string;

  beforeEach(async () => {
    detector = new ArtifactDetector();

    // Create temporary test directory structure
    testProjectRoot = path.join(process.cwd(), 'test-temp-project-' + Date.now());
    testOutputDir = path.join(testProjectRoot, '_bmad-output', 'planning-artifacts');

    await fs.mkdir(testOutputDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testProjectRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('detects completed workflows after app restart', () => {
    it('should detect single completed workflow artifact', async () => {
      // Simulate workflow completion by creating artifact file
      // create-prd has totalSteps: 12, so we need stepsCompleted with max >= 12
      const prdPath = path.join(testOutputDir, 'prd.md');
      await fs.writeFile(prdPath, '---\nstepsCompleted: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]\n---\n# PRD Content');

      // Simulate app restart by calling detect() (state reconstruction)
      const result = await detector.detect(testProjectRoot);

      expect(result.completedWorkflows).toContain('create-prd');
      expect(result.detectedArtifacts['create-prd']).toBeDefined();
      expect(result.detectedArtifacts['create-prd'].path).toBe(prdPath);
      expect(result.detectedArtifacts['create-prd'].stepsCompleted).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    });

    it('should detect multiple completed workflow artifacts', async () => {
      // Create multiple artifacts with all steps completed
      // create-prd has totalSteps: 12, create-architecture has totalSteps: 8
      const prdPath = path.join(testOutputDir, 'prd.md');
      const archPath = path.join(testOutputDir, 'architecture.md');

      await fs.writeFile(prdPath, '---\nstepsCompleted: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]\n---\n# PRD');
      await fs.writeFile(archPath, '---\nstepsCompleted: ["1", "2", "3", "4", "5", "6", "7", "8"]\n---\n# Architecture');

      const result = await detector.detect(testProjectRoot);

      expect(result.completedWorkflows).toContain('create-prd');
      expect(result.completedWorkflows).toContain('create-architecture');
      expect(result.detectedArtifacts['create-prd'].stepsCompleted).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
      expect(result.detectedArtifacts['create-architecture'].stepsCompleted).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    });

    it('should detect workflow artifacts with wildcard patterns', async () => {
      // research workflow uses pattern: planning-artifacts/research*.md, totalSteps: 3
      const brainstormPath = path.join(testOutputDir, 'research-session-1.md');
      await fs.writeFile(brainstormPath, '---\nstepsCompleted: ["1", "2", "3"]\n---\n# Research');

      const result = await detector.detect(testProjectRoot);

      expect(result.completedWorkflows).toContain('research');
      expect(result.detectedArtifacts['research']).toBeDefined();
    });
  });

  describe('handles greenfield project (empty directory)', () => {
    it('should return empty state when _bmad-output directory is empty', async () => {
      // Directory exists but is empty (no artifacts)
      const result = await detector.detect(testProjectRoot);

      expect(result.completedWorkflows).toEqual([]);
      expect(result.detectedArtifacts).toEqual({});
    });

    it('should return empty state when _bmad-output directory does not exist', async () => {
      // Remove the _bmad-output directory entirely
      await fs.rm(path.join(testProjectRoot, '_bmad-output'), { recursive: true, force: true });

      const result = await detector.detect(testProjectRoot);

      expect(result.completedWorkflows).toEqual([]);
      expect(result.detectedArtifacts).toEqual({});
    });
  });

  describe('parses YAML frontmatter correctly', () => {
    it('should extract stepsCompleted array from frontmatter', async () => {
      const prdPath = path.join(testOutputDir, 'prd.md');
      const frontmatter = `---
stepsCompleted: ["step-1", "step-2", "step-3"]
---
# Product Requirements Document

Content here...`;

      await fs.writeFile(prdPath, frontmatter);

      const result = await detector.detect(testProjectRoot);

      expect(result.detectedArtifacts['create-prd'].stepsCompleted).toEqual(['step-1', 'step-2', 'step-3']);
    });

    it('should handle artifacts without frontmatter', async () => {
      const prdPath = path.join(testOutputDir, 'prd.md');
      await fs.writeFile(prdPath, '# PRD\n\nNo frontmatter here');

      const result = await detector.detect(testProjectRoot);

      // Artifact detected by file existence, but no stepsCompleted
      expect(result.completedWorkflows).toContain('create-prd');
      expect(result.detectedArtifacts['create-prd'].stepsCompleted).toBeUndefined();
    });

    it('should handle frontmatter without stepsCompleted field', async () => {
      const prdPath = path.join(testOutputDir, 'prd.md');
      const frontmatter = `---
title: Product Requirements Document
author: Test
---
# Content`;

      await fs.writeFile(prdPath, frontmatter);

      const result = await detector.detect(testProjectRoot);

      expect(result.completedWorkflows).toContain('create-prd');
      expect(result.detectedArtifacts['create-prd'].stepsCompleted).toBeUndefined();
    });
  });

  describe('handles corrupted artifacts gracefully', () => {
    it('should continue detection when one artifact has corrupted frontmatter', async () => {
      const prdPath = path.join(testOutputDir, 'prd.md');
      const archPath = path.join(testOutputDir, 'architecture.md');

      // prd has corrupted YAML - treated as completed (no stepsCompleted means legacy artifact)
      await fs.writeFile(prdPath, '---\ninvalid: yaml: syntax: error\n---\nContent');

      // architecture is valid with all steps (totalSteps: 8)
      await fs.writeFile(archPath, '---\nstepsCompleted: ["1", "2", "3", "4", "5", "6", "7", "8"]\n---\n# Architecture');

      const result = await detector.detect(testProjectRoot);

      // Both artifacts detected - prd is completed (corrupted = no stepsCompleted = legacy)
      // architecture is completed (all 8 steps done)
      expect(result.completedWorkflows).toContain('create-prd');
      expect(result.completedWorkflows).toContain('create-architecture');

      // create-prd has no stepsCompleted (parse failed), create-architecture does
      expect(result.detectedArtifacts['create-prd'].stepsCompleted).toBeUndefined();
      expect(result.detectedArtifacts['create-architecture'].stepsCompleted).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    });

    it('should handle file read errors during frontmatter parsing', async () => {
      const prdPath = path.join(testOutputDir, 'prd.md');
      await fs.writeFile(prdPath, 'Content');

      // Make file temporarily unreadable on Unix systems (skip on Windows)
      if (process.platform !== 'win32') {
        await fs.chmod(prdPath, 0o000);

        await detector.detect(testProjectRoot);

        // Artifact may not be detected if glob fails to read it
        // Or it may be detected but frontmatter parsing fails
        // Either way, should not crash

        // Restore permissions for cleanup
        await fs.chmod(prdPath, 0o644);
      }
    });
  });

  describe('cross-platform path handling', () => {
    it('should correctly resolve paths on current platform', async () => {
      const prdPath = path.join(testOutputDir, 'prd.md');
      await fs.writeFile(prdPath, '# PRD');

      const result = await detector.detect(testProjectRoot);

      // Path should use platform-specific separators
      expect(result.detectedArtifacts['create-prd'].path).toBe(prdPath);
      expect(result.detectedArtifacts['create-prd'].path).toContain(path.sep);
    });

    it('should work with nested directory structures', async () => {
      // research uses wildcard pattern: planning-artifacts/research*.md, totalSteps: 3
      // This test creates a research artifact with a descriptive filename
      const brainstormPath = path.join(testOutputDir, 'research-sprint-planning.md');
      await fs.writeFile(brainstormPath, '---\nstepsCompleted: ["1", "2", "3"]\n---\n# Research Sprint Planning');

      const result = await detector.detect(testProjectRoot);

      expect(result.completedWorkflows).toContain('research');
      expect(result.detectedArtifacts['research'].path).toBe(brainstormPath);
    });
  });

  describe('state reconstruction from file system', () => {
    it('should reconstruct complete state from multiple artifact files', async () => {
      // Simulate multiple completed workflows with all steps done
      // create-prd: 12 steps, create-architecture: 8 steps, research: 3 steps
      const artifacts = [
        { name: 'prd.md', workflow: 'create-prd', steps: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'] },
        { name: 'architecture.md', workflow: 'create-architecture', steps: ['1', '2', '3', '4', '5', '6', '7', '8'] },
        { name: 'research-session-1.md', workflow: 'research', steps: ['1', '2', '3'] },
      ];

      for (const artifact of artifacts) {
        const artifactPath = path.join(testOutputDir, artifact.name);
        const content = `---\nstepsCompleted: ${JSON.stringify(artifact.steps)}\n---\n# Content`;
        await fs.writeFile(artifactPath, content);
      }

      const result = await detector.detect(testProjectRoot);

      expect(result.completedWorkflows).toHaveLength(3);
      expect(result.completedWorkflows).toContain('create-prd');
      expect(result.completedWorkflows).toContain('create-architecture');
      expect(result.completedWorkflows).toContain('research');

      expect(result.detectedArtifacts['create-prd'].stepsCompleted).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
      expect(result.detectedArtifacts['create-architecture'].stepsCompleted).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
      expect(result.detectedArtifacts['research'].stepsCompleted).toEqual(['1', '2', '3']);
    });

    it('should handle partial workflow completion state', async () => {
      // create-prd has totalSteps: 12, so 2 steps is in-progress
      const prdPath = path.join(testOutputDir, 'prd.md');
      await fs.writeFile(prdPath, '---\nstepsCompleted: ["1", "2"]\n---\n# Partial PRD');

      const result = await detector.detect(testProjectRoot);

      // Partial completion should be in inProgressWorkflows, not completedWorkflows
      expect(result.inProgressWorkflows).toContain('create-prd');
      expect(result.completedWorkflows).not.toContain('create-prd');
      expect(result.detectedArtifacts['create-prd'].stepsCompleted).toHaveLength(2);
    });
  });
});
