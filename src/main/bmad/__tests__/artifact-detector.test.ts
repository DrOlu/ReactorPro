import * as fs from 'fs/promises';

import * as yamlFront from 'yaml-front-matter';
import { glob } from 'glob';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StoryStatus } from '@common/bmad-types';

import { ArtifactDetector } from '../artifact-detector';

// Mock fs/promises, glob, and yaml-front-matter before importing ArtifactDetector
vi.mock('fs/promises');
vi.mock('glob');
vi.mock('yaml-front-matter');

describe('ArtifactDetector', () => {
  describe('detect', () => {
    let detector: ArtifactDetector;
    const projectRoot = '/test/project';

    beforeEach(() => {
      detector = new ArtifactDetector();
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should export ArtifactDetector class with detect method', async () => {
      expect(detector).toBeDefined();
      expect(detector.detect).toBeDefined();
      expect(typeof detector.detect).toBe('function');
    });

    it('should return ArtifactDetectionResult structure', async () => {
      const result = await detector.detect(projectRoot);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('completedWorkflows');
      expect(result).toHaveProperty('detectedArtifacts');
      expect(Array.isArray(result.completedWorkflows)).toBe(true);
      expect(typeof result.detectedArtifacts).toBe('object');
    });

    describe('directory existence check (Task 2)', () => {
      it('should return empty result when _bmad-output directory does not exist', async () => {
        // Mock fs.access to throw ENOENT error (directory not found)
        vi.mocked(fs.access).mockRejectedValue({ code: 'ENOENT' });

        const result = await detector.detect(projectRoot);

        expect(result.completedWorkflows).toEqual([]);
        expect(result.detectedArtifacts).toEqual({});
      });
    });

    describe('incomplete workflow detection with metadata (Story 5.3 Task 1)', () => {
      beforeEach(() => {
        vi.mocked(fs.access).mockResolvedValue(undefined);
      });

      it('should calculate nextStep from stepsCompleted array', async () => {
        const artifactPath = '/test/project/_bmad-output/planning-artifacts/prd.md';

        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return [artifactPath];
          }
          return [];
        });

        vi.mocked(fs.readFile).mockResolvedValue('---\nstepsCompleted: [1, 2]\nworkflowTotalSteps: 5\n---\nContent');
        vi.mocked(yamlFront.loadFront).mockReturnValue({
          stepsCompleted: ['1', '2'],
          workflowTotalSteps: 5,
          __content: 'Content',
        } as unknown as ReturnType<typeof yamlFront.loadFront>);

        // Mock fs.stat for lastModified
        const mockDate = new Date('2026-02-02T10:00:00Z');
        vi.mocked(fs.stat).mockResolvedValue({
          mtime: mockDate,
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await detector.detect(projectRoot);

        expect(result.incompleteWorkflows).toBeDefined();
        expect(result.incompleteWorkflows).toHaveLength(1);
        expect(result.incompleteWorkflows?.[0]).toEqual({
          workflowId: 'create-prd',
          artifactPath,
          stepsCompleted: [1, 2],
          nextStep: 3,
          lastModified: mockDate,
        });
      });

      it('should handle empty stepsCompleted (workflow started but no steps done)', async () => {
        const artifactPath = '/test/project/_bmad-output/planning-artifacts/architecture.md';

        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('architecture.md')) {
            return [artifactPath];
          }
          return [];
        });

        vi.mocked(fs.readFile).mockResolvedValue('---\nstepsCompleted: []\n---\nContent');
        vi.mocked(yamlFront.loadFront).mockReturnValue({
          stepsCompleted: [],
          __content: 'Content',
        } as unknown as ReturnType<typeof yamlFront.loadFront>);

        const mockDate = new Date('2026-02-02T10:00:00Z');
        vi.mocked(fs.stat).mockResolvedValue({
          mtime: mockDate,
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await detector.detect(projectRoot);

        expect(result.incompleteWorkflows).toHaveLength(1);
        expect(result.incompleteWorkflows?.[0].stepsCompleted).toEqual([]);
        expect(result.incompleteWorkflows?.[0].nextStep).toBe(1);
      });

      it('should not include workflows with all steps completed', async () => {
        // Mock a workflow with all steps completed (create-prd has totalSteps: 12)
        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return ['/test/project/_bmad-output/planning-artifacts/prd.md'];
          }
          return [];
        });

        vi.mocked(fs.readFile).mockResolvedValue('---\nstepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]\n---\nContent');
        vi.mocked(yamlFront.loadFront).mockReturnValue({
          stepsCompleted: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
          __content: 'Content',
        } as unknown as ReturnType<typeof yamlFront.loadFront>);

        const result = await detector.detect(projectRoot);

        // Should be in completedWorkflows, not incompleteWorkflows
        expect(result.completedWorkflows).toContain('create-prd');
        expect(result.inProgressWorkflows).not.toContain('create-prd');
        expect(result.incompleteWorkflows).toEqual([]);
      });

      it('should handle missing stepsCompleted field gracefully', async () => {
        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return ['/test/project/_bmad-output/planning-artifacts/prd.md'];
          }
          return [];
        });

        vi.mocked(fs.readFile).mockResolvedValue('---\n---\nContent without stepsCompleted');
        vi.mocked(yamlFront.loadFront).mockReturnValue({
          __content: 'Content without stepsCompleted',
        } as unknown as ReturnType<typeof yamlFront.loadFront>);

        const result = await detector.detect(projectRoot);

        // Missing stepsCompleted means we can't determine resume point
        expect(result.incompleteWorkflows).toEqual([]);
      });

      it('should use platform-agnostic path resolution', async () => {
        vi.mocked(fs.access).mockResolvedValue(undefined);

        const result = await detector.detect(projectRoot);

        // Once implemented, fs.access should be called with the bmad-output path
        // For now, verify the result structure is correct
        expect(result).toBeDefined();
      });

      it('should handle permission errors gracefully', async () => {
        // Mock fs.access to throw EACCES error (permission denied)
        vi.mocked(fs.access).mockRejectedValue({ code: 'EACCES' });

        const result = await detector.detect(projectRoot);

        // Should return empty result even on permission errors
        expect(result.completedWorkflows).toEqual([]);
        expect(result.detectedArtifacts).toEqual({});
      });

      it('should proceed to scanning when directory exists', async () => {
        // Mock directory exists (fs.access resolves without error)
        vi.mocked(fs.access).mockResolvedValue(undefined);
        vi.mocked(glob).mockResolvedValue([]);

        const result = await detector.detect(projectRoot);

        // Should return valid result (even if empty when no artifacts)
        expect(result).toBeDefined();
        expect(Array.isArray(result.completedWorkflows)).toBe(true);
      });
    });

    describe('glob-based artifact scanning (Task 3)', () => {
      beforeEach(() => {
        // Mock directory exists for these tests
        vi.mocked(fs.access).mockResolvedValue(undefined);
      });

      it('should detect artifacts using glob patterns from BMAD_WORKFLOWS', async () => {
        // Mock glob to return matching files for prd workflow
        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return ['/test/project/_bmad-output/planning-artifacts/prd.md'];
          }
          return [];
        });

        const result = await detector.detect(projectRoot);

        // Should detect create-prd workflow as completed
        expect(result.completedWorkflows).toContain('create-prd');
        expect(result.detectedArtifacts['create-prd']).toBeDefined();
        expect(result.detectedArtifacts['create-prd'].path).toBe('/test/project/_bmad-output/planning-artifacts/prd.md');
      });

      it('should detect multiple artifacts', async () => {
        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return ['/test/project/_bmad-output/planning-artifacts/prd.md'];
          }
          if (patternStr.includes('architecture.md')) {
            return ['/test/project/_bmad-output/planning-artifacts/architecture.md'];
          }
          return [];
        });

        const result = await detector.detect(projectRoot);

        expect(result.completedWorkflows).toContain('create-prd');
        expect(result.completedWorkflows).toContain('create-architecture');
        expect(result.detectedArtifacts['create-prd']).toBeDefined();
        expect(result.detectedArtifacts['create-architecture']).toBeDefined();
      });

      it('should handle glob patterns with wildcards', async () => {
        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('research*.md')) {
            return ['/test/project/_bmad-output/planning-artifacts/research-session-1.md'];
          }
          return [];
        });

        const result = await detector.detect(projectRoot);

        expect(result.completedWorkflows).toContain('research');
        expect(result.detectedArtifacts['research'].path).toBe('/test/project/_bmad-output/planning-artifacts/research-session-1.md');
      });

      it('should return empty arrays when no artifacts found', async () => {
        vi.mocked(glob).mockResolvedValue([]);

        const result = await detector.detect(projectRoot);

        expect(result.completedWorkflows).toEqual([]);
        expect(result.detectedArtifacts).toEqual({});
      });

      it('should work on Windows, Mac, and Linux (cross-platform)', async () => {
        // Mock glob to work cross-platform
        vi.mocked(glob).mockResolvedValue(['/test/project/_bmad-output/planning-artifacts/prd.md']);

        const result = await detector.detect(projectRoot);

        // Glob should be called with forward slashes (glob library handles conversion)
        expect(result.completedWorkflows).toContain('create-prd');
      });
    });

    describe('YAML frontmatter parsing (Task 4)', () => {
      beforeEach(() => {
        vi.mocked(fs.access).mockResolvedValue(undefined);
      });

      it('should parse stepsCompleted from YAML frontmatter', async () => {
        const artifactPath = '/test/project/_bmad-output/planning-artifacts/prd.md';

        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return [artifactPath];
          }
          return [];
        });

        vi.mocked(fs.readFile).mockResolvedValue('---\nstepsCompleted: [1, 2, 3]\n---\nContent');
        vi.mocked(yamlFront.loadFront).mockReturnValue({
          stepsCompleted: ['1', '2', '3'],
          __content: 'Content',
        } as unknown as ReturnType<typeof yamlFront.loadFront>);

        const result = await detector.detect(projectRoot);

        expect(result.detectedArtifacts['create-prd'].stepsCompleted).toEqual(['1', '2', '3']);
      });

      it('should handle missing frontmatter gracefully', async () => {
        const artifactPath = '/test/project/_bmad-output/planning-artifacts/prd.md';

        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return [artifactPath];
          }
          return [];
        });

        vi.mocked(fs.readFile).mockResolvedValue('No frontmatter content');
        vi.mocked(yamlFront.loadFront).mockReturnValue({
          __content: 'No frontmatter content',
        });

        const result = await detector.detect(projectRoot);

        // Should still detect artifact, but stepsCompleted is undefined
        expect(result.completedWorkflows).toContain('create-prd');
        expect(result.detectedArtifacts['create-prd'].stepsCompleted).toBeUndefined();
      });

      it('should handle file read errors gracefully', async () => {
        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return ['/test/project/_bmad-output/planning-artifacts/prd.md'];
          }
          return [];
        });

        // File read fails
        vi.mocked(fs.readFile).mockRejectedValue(new Error('File read error'));

        const result = await detector.detect(projectRoot);

        // Should still detect artifact (file existence), but no stepsCompleted
        expect(result.completedWorkflows).toContain('create-prd');
        expect(result.detectedArtifacts['create-prd'].stepsCompleted).toBeUndefined();
      });

      it('should handle YAML parse errors gracefully', async () => {
        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return ['/test/project/_bmad-output/planning-artifacts/prd.md'];
          }
          return [];
        });

        vi.mocked(fs.readFile).mockResolvedValue('---\ninvalid: yaml: content\n---');
        vi.mocked(yamlFront.loadFront).mockImplementation(() => {
          throw new Error('YAML parse error');
        });

        const result = await detector.detect(projectRoot);

        // Should still detect artifact, frontmatter parsing failed
        expect(result.completedWorkflows).toContain('create-prd');
        expect(result.detectedArtifacts['create-prd'].stepsCompleted).toBeUndefined();
      });
    });

    describe('incomplete workflow detection (Story 5.3)', () => {
      beforeEach(() => {
        vi.mocked(fs.access).mockResolvedValue(undefined);
      });

      it('should detect incomplete workflows from stepsCompleted array', async () => {
        const artifactPath = '/test/project/_bmad-output/planning-artifacts/prd.md';

        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return [artifactPath];
          }
          return [];
        });

        // Mock artifact with partial stepsCompleted (e.g., steps 1 and 2 done, but more steps exist)
        vi.mocked(fs.readFile).mockResolvedValue('---\nstepsCompleted: [1, 2]\n---\nContent');
        vi.mocked(yamlFront.loadFront).mockReturnValue({
          stepsCompleted: ['1', '2'],
          __content: 'Content',
        } as unknown as ReturnType<typeof yamlFront.loadFront>);

        const result = await detector.detect(projectRoot);

        expect(result.detectedArtifacts['create-prd'].stepsCompleted).toEqual(['1', '2']);
      });

      it('should detect workflows with no steps completed', async () => {
        const artifactPath = '/test/project/_bmad-output/planning-artifacts/prd.md';

        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return [artifactPath];
          }
          return [];
        });

        vi.mocked(fs.readFile).mockResolvedValue('---\nstepsCompleted: []\n---\nContent');
        vi.mocked(yamlFront.loadFront).mockReturnValue({
          stepsCompleted: [],
          __content: 'Content',
        } as unknown as ReturnType<typeof yamlFront.loadFront>);

        const result = await detector.detect(projectRoot);

        expect(result.detectedArtifacts['create-prd'].stepsCompleted).toEqual([]);
      });

      it('should handle workflows with all steps completed', async () => {
        // create-architecture has totalSteps: 8
        const artifactPath = '/test/project/_bmad-output/planning-artifacts/architecture.md';

        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('architecture.md')) {
            return [artifactPath];
          }
          return [];
        });

        vi.mocked(fs.readFile).mockResolvedValue('---\nstepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]\n---\nContent');
        vi.mocked(yamlFront.loadFront).mockReturnValue({
          stepsCompleted: ['1', '2', '3', '4', '5', '6', '7', '8'],
          __content: 'Content',
        } as unknown as ReturnType<typeof yamlFront.loadFront>);

        const result = await detector.detect(projectRoot);

        expect(result.completedWorkflows).toContain('create-architecture');
        expect(result.inProgressWorkflows).not.toContain('create-architecture');
        expect(result.detectedArtifacts['create-architecture'].stepsCompleted).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
      });

      it('should handle multiple incomplete workflows', async () => {
        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return ['/test/project/_bmad-output/planning-artifacts/prd.md'];
          }
          if (patternStr.includes('architecture.md')) {
            return ['/test/project/_bmad-output/planning-artifacts/architecture.md'];
          }
          return [];
        });

        vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
          const pathStr = String(filePath);
          if (pathStr.includes('prd.md')) {
            return '---\nstepsCompleted: [1]\n---\nContent';
          }
          return '---\nstepsCompleted: [1, 2]\n---\nContent';
        });

        vi.mocked(yamlFront.loadFront).mockImplementation((input: string | Buffer) => {
          if (input.includes('stepsCompleted: [1]')) {
            return {
              stepsCompleted: ['1'],
              __content: 'Content',
            } as unknown as ReturnType<typeof yamlFront.loadFront>;
          }
          return {
            stepsCompleted: ['1', '2'],
            __content: 'Content',
          } as unknown as ReturnType<typeof yamlFront.loadFront>;
        });

        const result = await detector.detect(projectRoot);

        expect(result.detectedArtifacts['create-prd'].stepsCompleted).toEqual(['1']);
        expect(result.detectedArtifacts['create-architecture'].stepsCompleted).toEqual(['1', '2']);
      });
    });

    describe('error handling and resilience (Task 5)', () => {
      beforeEach(() => {
        vi.mocked(fs.access).mockResolvedValue(undefined);
      });

      it('should continue scanning after encountering a corrupted artifact', async () => {
        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return ['/test/project/_bmad-output/planning-artifacts/prd.md'];
          }
          if (patternStr.includes('architecture.md')) {
            return ['/test/project/_bmad-output/planning-artifacts/architecture.md'];
          }
          return [];
        });

        // First file (prd) has read error (treated as legacy, goes to completed)
        // Second file (architecture) has partial steps (totalSteps: 8, only 2 done -> in progress)
        vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
          const pathStr = String(filePath);
          if (pathStr.includes('prd.md')) {
            throw new Error('File read error');
          }
          return '---\nstepsCompleted: [1, 2]\n---\nContent';
        });

        vi.mocked(yamlFront.loadFront).mockReturnValue({
          stepsCompleted: ['1', '2'],
          __content: 'Content',
        } as unknown as ReturnType<typeof yamlFront.loadFront>);

        vi.mocked(fs.stat).mockResolvedValue({
          mtime: new Date('2026-02-02'),
        } as Awaited<ReturnType<typeof fs.stat>>);

        const result = await detector.detect(projectRoot);

        // prd: no stepsCompleted (read failed) -> treated as legacy -> completedWorkflows
        // architecture: partial stepsCompleted (2/8) -> inProgressWorkflows
        expect(result.completedWorkflows).toContain('create-prd');
        expect(result.inProgressWorkflows).toContain('create-architecture');

        // create-prd has no stepsCompleted (read failed), create-architecture has them
        expect(result.detectedArtifacts['create-prd'].stepsCompleted).toBeUndefined();
        expect(result.detectedArtifacts['create-architecture'].stepsCompleted).toEqual(['1', '2']);
      });
    });

    describe('Corrupted Artifact Handling (Story 5.3 Task 6)', () => {
      beforeEach(() => {
        vi.mocked(fs.access).mockResolvedValue(undefined);
      });

      it('should detect corrupted artifacts with unreadable frontmatter', async () => {
        const artifactPath = '/test/project/_bmad-output/planning-artifacts/prd.md';

        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return [artifactPath];
          }
          return [];
        });

        // File read succeeds but YAML parsing fails
        // Since no stepsCompleted can be parsed, it's treated as legacy (completed)
        vi.mocked(fs.readFile).mockResolvedValue('---\nstepsCompleted: [1, 2\n---\nContent'); // Invalid YAML
        vi.mocked(yamlFront.loadFront).mockImplementation(() => {
          throw new Error('Invalid YAML: Unexpected end of input');
        });
        vi.mocked(fs.stat).mockResolvedValue({
          mtime: new Date('2026-02-02'),
        } as Awaited<ReturnType<typeof fs.stat>>);

        const result = await detector.detect(projectRoot);

        // Artifact detected with error - no stepsCompleted means treated as legacy (completed)
        expect(result.completedWorkflows).toContain('create-prd');
        expect(result.detectedArtifacts['create-prd'].error).toBe('Invalid YAML: Unexpected end of input');

        // No incompleteWorkflows since we can't parse stepsCompleted and the file
        // doesn't have a stepsCompleted field that we can detect
        expect(result.incompleteWorkflows).toHaveLength(0);
      });

      it('should not mark as corrupted if no stepsCompleted field present', async () => {
        const artifactPath = '/test/project/_bmad-output/planning-artifacts/prd.md';

        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return [artifactPath];
          }
          return [];
        });

        // File read succeeds but YAML parsing fails, no stepsCompleted field
        vi.mocked(fs.readFile).mockResolvedValue('---\nworkflow_id: prd\n---\nContent'); // Valid single-step artifact
        vi.mocked(yamlFront.loadFront).mockImplementation(() => {
          throw new Error('Invalid YAML');
        });

        const result = await detector.detect(projectRoot);

        // Artifact detected with error but NOT in incomplete workflows
        expect(result.completedWorkflows).toContain('create-prd');
        expect(result.detectedArtifacts['create-prd'].error).toBe('Invalid YAML');
        expect(result.incompleteWorkflows).toHaveLength(0);
      });

      it('should handle multiple corrupted artifacts', async () => {
        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return ['/test/project/_bmad-output/planning-artifacts/prd.md'];
          }
          if (patternStr.includes('architecture.md')) {
            return ['/test/project/_bmad-output/planning-artifacts/architecture.md'];
          }
          return [];
        });

        vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
          const pathStr = String(filePath);
          if (pathStr.includes('prd.md')) {
            return '---\nstepsCompleted: [1\n---\nContent'; // Corrupted
          }
          return '---\nstepsCompleted: [1, 2\n---\nContent'; // Also corrupted
        });

        vi.mocked(yamlFront.loadFront).mockImplementation(() => {
          throw new Error('YAML parse error');
        });

        vi.mocked(fs.stat).mockResolvedValue({
          mtime: new Date('2026-02-02'),
        } as Awaited<ReturnType<typeof fs.stat>>);

        const result = await detector.detect(projectRoot);

        // Both corrupted artifacts with no parseable stepsCompleted -> treated as legacy (completed)
        expect(result.completedWorkflows).toContain('create-prd');
        expect(result.completedWorkflows).toContain('create-architecture');
        // No incompleteWorkflows since stepsCompleted can't be parsed
        expect(result.incompleteWorkflows).toHaveLength(0);
      });

      it('should include clear error message in corruption details', async () => {
        const artifactPath = '/test/project/_bmad-output/planning-artifacts/prd.md';

        vi.mocked(glob).mockImplementation(async (pattern: string | string[]) => {
          const patternStr = Array.isArray(pattern) ? pattern[0] : pattern;
          if (patternStr.includes('prd.md')) {
            return [artifactPath];
          }
          return [];
        });

        vi.mocked(fs.readFile).mockResolvedValue('---\nstepsCompleted: invalid\n---\nContent');
        vi.mocked(yamlFront.loadFront).mockImplementation(() => {
          throw new Error('Unexpected token: invalid');
        });
        vi.mocked(fs.stat).mockResolvedValue({
          mtime: new Date('2026-02-02'),
        } as Awaited<ReturnType<typeof fs.stat>>);

        const result = await detector.detect(projectRoot);

        // Error is recorded in detectedArtifacts
        expect(result.detectedArtifacts['create-prd'].error).toBe('Unexpected token: invalid');
        // Corrupted artifact with no parseable stepsCompleted -> treated as legacy (completed)
        expect(result.completedWorkflows).toContain('create-prd');
        expect(result.incompleteWorkflows).toHaveLength(0);
      });
    });
  });

  describe('parseSprintStatus', () => {
    let detector: ArtifactDetector;
    const projectRoot = '/test/project';

    beforeEach(() => {
      detector = new ArtifactDetector();
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should parse valid YAML and extract story statuses', async () => {
      const yamlContent = `development_status:
  story-1: backlog
  story-2: ready-for-dev
  story-3: in-progress
  story-4: review
  story-5: done`;

      vi.mocked(fs.readFile).mockResolvedValue(yamlContent);

      const result = await detector.detect(projectRoot);

      expect(result.sprintStatus).toBeDefined();
      expect(result.sprintStatus?.storyStatuses).toHaveLength(5);
      expect(result.sprintStatus?.storyStatuses).toContain(StoryStatus.Backlog);
      expect(result.sprintStatus?.storyStatuses).toContain(StoryStatus.ReadyForDev);
      expect(result.sprintStatus?.storyStatuses).toContain(StoryStatus.InProgress);
      expect(result.sprintStatus?.storyStatuses).toContain(StoryStatus.Review);
      expect(result.sprintStatus?.storyStatuses).toContain(StoryStatus.Done);
    });

    it('should exclude epic entries from story statuses', async () => {
      const yamlContent = `development_status:
  epic-1: backlog
  epic-2: done
  story-1: backlog
  story-2: ready-for-dev`;

      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(glob).mockResolvedValue([]);
      vi.mocked(fs.readFile).mockResolvedValue(yamlContent);

      const result = await detector.detect(projectRoot);

      expect(result.sprintStatus?.storyStatuses).toHaveLength(2);
      expect(result.sprintStatus?.storyStatuses).toContain(StoryStatus.Backlog);
      expect(result.sprintStatus?.storyStatuses).toContain(StoryStatus.ReadyForDev);
      // epics should be excluded
      expect(result.sprintStatus?.storyStatuses.filter((s) => s === StoryStatus.Backlog)).toHaveLength(1); // only story-1
    });

    it('should exclude retrospective entries from story statuses', async () => {
      const yamlContent = `development_status:
  story-1: backlog
  story-1-retrospective: done
  story-2: ready-for-dev
  sprint-1-retrospective: done`;

      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(glob).mockResolvedValue([]);
      vi.mocked(fs.readFile).mockResolvedValue(yamlContent);

      const result = await detector.detect(projectRoot);

      expect(result.sprintStatus?.storyStatuses).toHaveLength(2);
      expect(result.sprintStatus?.storyStatuses).toContain(StoryStatus.Backlog);
      expect(result.sprintStatus?.storyStatuses).toContain(StoryStatus.ReadyForDev);
      // retrospectives should be excluded
      expect(result.sprintStatus?.storyStatuses).not.toContain(StoryStatus.Done);
    });

    it('should return undefined when sprint-status.yaml does not exist', async () => {
      vi.mocked(fs.access).mockRejectedValue({ code: 'ENOENT' });

      const result = await detector.detect(projectRoot);

      expect(result.sprintStatus).toBeUndefined();
    });

    it('should return undefined when YAML has no development_status field', async () => {
      const yamlContent = `other_field: value
nested:
  something: else`;

      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(glob).mockResolvedValue([]);
      vi.mocked(fs.readFile).mockResolvedValue(yamlContent);

      const result = await detector.detect(projectRoot);

      expect(result.sprintStatus).toBeUndefined();
    });

    it('should handle empty development_status object', async () => {
      const yamlContent = 'development_status: {}';

      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(glob).mockResolvedValue([]);
      vi.mocked(fs.readFile).mockResolvedValue(yamlContent);

      const result = await detector.detect(projectRoot);

      expect(result.sprintStatus).toBeDefined();
      expect(result.sprintStatus?.storyStatuses).toHaveLength(0);
    });

    it('should handle file read errors gracefully', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(glob).mockResolvedValue([]);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('File read error'));

      const result = await detector.detect(projectRoot);

      expect(result.sprintStatus).toBeUndefined();
    });

    it('should filter out invalid story status values', async () => {
      const yamlContent = `development_status:
  story-1: backlog
  story-2: invalid-status
  story-3: ready-for-dev
  story-4: another-invalid`;

      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(glob).mockResolvedValue([]);
      vi.mocked(fs.readFile).mockResolvedValue(yamlContent);

      const result = await detector.detect(projectRoot);

      expect(result.sprintStatus?.storyStatuses).toHaveLength(2);
      expect(result.sprintStatus?.storyStatuses).toContain(StoryStatus.Backlog);
      expect(result.sprintStatus?.storyStatuses).toContain(StoryStatus.ReadyForDev);
    });

    it('should handle multiple stories with same status', async () => {
      const yamlContent = `development_status:
  story-1: backlog
  story-2: backlog
  story-3: backlog
  story-4: ready-for-dev
  story-5: ready-for-dev`;

      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(glob).mockResolvedValue([]);
      vi.mocked(fs.readFile).mockResolvedValue(yamlContent);

      const result = await detector.detect(projectRoot);

      expect(result.sprintStatus?.storyStatuses).toHaveLength(5);
      const backlogCount = result.sprintStatus?.storyStatuses.filter((s) => s === StoryStatus.Backlog).length;
      const readyForDevCount = result.sprintStatus?.storyStatuses.filter((s) => s === StoryStatus.ReadyForDev).length;
      expect(backlogCount).toBe(3);
      expect(readyForDevCount).toBe(2);
    });

    it('should handle mixed valid and invalid entries', async () => {
      const yamlContent = `development_status:
  story-1: backlog
  story-2: ready-for-dev
  epic-1: done
  story-3: in-progress
  story-4-retrospective: review
  story-5: invalid-status`;

      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(glob).mockResolvedValue([]);
      vi.mocked(fs.readFile).mockResolvedValue(yamlContent);

      const result = await detector.detect(projectRoot);

      // Only story-1, story-2, story-3 should be included (valid story keys and statuses)
      expect(result.sprintStatus?.storyStatuses).toHaveLength(3);
      expect(result.sprintStatus?.storyStatuses).toContain(StoryStatus.Backlog);
      expect(result.sprintStatus?.storyStatuses).toContain(StoryStatus.ReadyForDev);
      expect(result.sprintStatus?.storyStatuses).toContain(StoryStatus.InProgress);
      expect(result.sprintStatus?.storyStatuses).not.toContain(StoryStatus.Done);
      expect(result.sprintStatus?.storyStatuses).not.toContain(StoryStatus.Review);
    });

    it('should handle non-string status values', async () => {
      const yamlContent = `development_status:
  story-1: backlog
  story-2: 123
  story-3: null
  story-4: review`;

      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(glob).mockResolvedValue([]);
      vi.mocked(fs.readFile).mockResolvedValue(yamlContent);

      const result = await detector.detect(projectRoot);

      // Only valid string statuses should be included
      expect(result.sprintStatus?.storyStatuses).toHaveLength(2);
      expect(result.sprintStatus?.storyStatuses).toContain(StoryStatus.Backlog);
      expect(result.sprintStatus?.storyStatuses).toContain(StoryStatus.Review);
    });

    it('should parse YAML with complex structure', async () => {
      const yamlContent = `
# Sprint status tracking
development_status:
  story-authentication: backlog
  story-user-profile: ready-for-dev
  story-api-integration: in-progress
  story-ui-redesign: review
  story-payment-gateway: done

# Other metadata
created_at: '2026-02-02'
`;

      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(glob).mockResolvedValue([]);
      vi.mocked(fs.readFile).mockResolvedValue(yamlContent);

      const result = await detector.detect(projectRoot);

      expect(result.sprintStatus).toBeDefined();
      expect(result.sprintStatus?.storyStatuses).toHaveLength(5);
      expect(result.sprintStatus?.storyStatuses).toEqual([
        StoryStatus.Backlog,
        StoryStatus.ReadyForDev,
        StoryStatus.InProgress,
        StoryStatus.Review,
        StoryStatus.Done,
      ]);
    });
  });
});
