import { describe, it, expect, vi, beforeEach } from 'vitest';

import { BmadManager } from '../bmad-manager';
import { ArtifactDetector } from '../artifact-detector';
import { BMAD_WORKFLOWS } from '../../../common/bmad-workflows';

import type { ArtifactDetectionResult } from '../../../common/bmad-types';

// Mock ArtifactDetector
vi.mock('../artifact-detector');

// Mock file system operations
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => JSON.stringify({ version: '1.0.0' })),
  },
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => JSON.stringify({ version: '1.0.0' })),
}));

vi.mock('fs/promises');

describe('BmadManager - Status', () => {
  let bmadManager: BmadManager;
  const mockProjectPath = '/mock/project/path';

  beforeEach(() => {
    vi.clearAllMocks();
    bmadManager = new BmadManager(mockProjectPath);
  });

  describe('getBmadStatus - Response Structure', () => {
    it('populates all BmadStatus fields correctly', async () => {
      const mockDetectionResult: ArtifactDetectionResult = {
        completedWorkflows: ['create-product-brief'],
        inProgressWorkflows: [],
        detectedArtifacts: {
          'create-product-brief': {
            path: 'planning-artifacts/product-brief-example.md',
          },
        },
      };

      vi.mocked(ArtifactDetector.prototype.detect).mockResolvedValue(mockDetectionResult);

      const status = await bmadManager.getBmadStatus();

      // Verify all required fields are present (suggestedWorkflows moved to renderer)
      expect(status).toHaveProperty('installed');
      expect(status).toHaveProperty('version');
      expect(status).toHaveProperty('availableWorkflows');
      expect(status).toHaveProperty('completedWorkflows');
      expect(status).toHaveProperty('detectedArtifacts');

      // Verify field types and values
      expect(typeof status.installed).toBe('boolean');
      expect(Array.isArray(status.availableWorkflows)).toBe(true);
      expect(Array.isArray(status.completedWorkflows)).toBe(true);
      expect(typeof status.detectedArtifacts).toBe('object');

      // Verify availableWorkflows equals BMAD_WORKFLOWS
      expect(status.availableWorkflows).toEqual(BMAD_WORKFLOWS);

      // Verify completedWorkflows from detection result
      expect(status.completedWorkflows).toEqual(mockDetectionResult.completedWorkflows);

      // Verify detectedArtifacts from detection result
      expect(status.detectedArtifacts).toEqual(mockDetectionResult);
    });

    it('returns empty completed workflows for greenfield projects', async () => {
      const mockDetectionResult: ArtifactDetectionResult = {
        completedWorkflows: [],
        inProgressWorkflows: [],
        detectedArtifacts: {},
      };

      vi.mocked(ArtifactDetector.prototype.detect).mockResolvedValue(mockDetectionResult);

      const status = await bmadManager.getBmadStatus();

      expect(status.completedWorkflows).toEqual([]);
      expect(status.detectedArtifacts.completedWorkflows).toEqual([]);
    });

    it('returns detected artifacts from artifact detector', async () => {
      const mockDetectionResult: ArtifactDetectionResult = {
        completedWorkflows: ['create-product-brief', 'create-prd'],
        inProgressWorkflows: ['create-architecture'],
        detectedArtifacts: {
          'create-product-brief': {
            path: 'planning-artifacts/product-brief-example.md',
          },
          'create-prd': {
            path: 'planning-artifacts/prd.md',
          },
        },
      };

      vi.mocked(ArtifactDetector.prototype.detect).mockResolvedValue(mockDetectionResult);

      const status = await bmadManager.getBmadStatus();

      expect(status.completedWorkflows).toEqual(['create-product-brief', 'create-prd']);
      expect(status.inProgressWorkflows).toEqual(['create-architecture']);
      expect(status.detectedArtifacts).toEqual(mockDetectionResult);
    });
  });
});
