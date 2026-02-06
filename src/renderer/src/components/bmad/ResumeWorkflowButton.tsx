import { IncompleteWorkflowMetadata } from '@common/bmad-types';
import { BMAD_WORKFLOWS } from '@common/bmad-workflows';
import { MouseEvent, useState } from 'react';
import { CgSpinner } from 'react-icons/cg';
import { FaPlayCircle, FaRedo, FaExclamationTriangle } from 'react-icons/fa';
import { FiFile, FiExternalLink } from 'react-icons/fi';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { formatDistanceToNow } from 'date-fns';

import { useApi } from '@/contexts/ApiContext';
import { showErrorNotification } from '@/utils/notifications';
import { useBmadState } from '@/hooks/useBmadState';

const getFileName = (path: string): string => {
  const parts = path.split('/');
  return parts[parts.length - 1];
};

type Props = {
  incompleteWorkflow: IncompleteWorkflowMetadata;
  projectDir: string;
  taskId: string;
};

export const ResumeWorkflowButton = ({ incompleteWorkflow, projectDir, taskId }: Props) => {
  const { t } = useTranslation();
  const api = useApi();
  const { refresh } = useBmadState();
  const [loading, setLoading] = useState(false);

  // Find workflow metadata
  const workflow = BMAD_WORKFLOWS.find((w) => w.id === incompleteWorkflow.workflowId);
  const workflowName = workflow?.name || incompleteWorkflow.workflowId;

  // Check if corrupted
  const isCorrupted = incompleteWorkflow.corrupted === true;

  // Calculate progress
  const currentStep = incompleteWorkflow.nextStep;
  const totalSteps = incompleteWorkflow.stepsCompleted.length > 0 ? Math.max(...incompleteWorkflow.stepsCompleted) + 2 : currentStep + 1;

  // Format last modified time
  const lastModifiedRelative = formatDistanceToNow(new Date(incompleteWorkflow.lastModified), { addSuffix: true });

  const handleResumeWorkflow = async (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();

    if (loading) {
      return;
    }

    setLoading(true);

    try {
      const result = await api.executeWorkflow(projectDir, taskId, incompleteWorkflow.workflowId);

      if (result.success) {
        await refresh();
      } else {
        const errorMessage = result.error?.message || t('bmad.workflows.workflowError');
        const fullMessage = result.error?.recoveryAction ? `${errorMessage}\n${result.error.recoveryAction}` : errorMessage;
        showErrorNotification(fullMessage);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showErrorNotification(`${t('bmad.workflows.workflowError')}: ${errorMessage}`);

      // eslint-disable-next-line no-console
      console.error('Workflow resume error:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleRestartFromBeginning = async (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();

    if (loading) {
      return;
    }

    setLoading(true);

    try {
      // Execute workflow from beginning (no resume options) - backend will backup corrupted artifact
      const result = await api.executeWorkflow(projectDir, taskId, incompleteWorkflow.workflowId);

      if (result.success) {
        await refresh();
      } else {
        const errorMessage = result.error?.message || t('bmad.workflows.workflowError');
        const fullMessage = result.error?.recoveryAction ? `${errorMessage}\n${result.error.recoveryAction}` : errorMessage;
        showErrorNotification(fullMessage);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showErrorNotification(`${t('bmad.workflows.workflowError')}: ${errorMessage}`);

      // eslint-disable-next-line no-console
      console.error('Workflow restart error:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenArtifact = async (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (incompleteWorkflow.artifactPath) {
      await api.openPath(incompleteWorkflow.artifactPath);
    }
  };

  // Corrupted workflow UI
  if (isCorrupted) {
    const buttonClass = clsx(
      'flex items-center gap-2 px-3 py-2 text-xs rounded-md transition-colors font-medium border',
      'focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2',
      {
        'bg-red-500 hover:bg-red-600 text-white border-red-500': !loading,
        'opacity-50 cursor-not-allowed': loading,
      },
    );

    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-start gap-2 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
          <FaExclamationTriangle className="w-4 h-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-red-800 dark:text-red-300">
              {t('bmad.resume.corrupted')}: {workflowName}
            </p>
            <p className="text-2xs text-red-700 dark:text-red-400 mt-0.5">{t('bmad.resume.corruptedDescription')}</p>
            {incompleteWorkflow.corruptionError && (
              <p className="text-2xs text-red-600 dark:text-red-500 mt-1 font-mono">{incompleteWorkflow.corruptionError}</p>
            )}
          </div>
        </div>
        <button
          onClick={handleRestartFromBeginning}
          className={buttonClass}
          disabled={loading}
          aria-label={loading ? t('bmad.resume.restarting') : t('bmad.resume.restartFromBeginning')}
          aria-disabled={loading}
          type="button"
        >
          {loading ? <CgSpinner className="animate-spin w-4 h-4" /> : <FaRedo className="w-4 h-4" />}
          <span className="flex-1">{loading ? t('bmad.resume.restarting') : t('bmad.resume.restartFromBeginning')}</span>
        </button>
        <p className="text-2xs text-text-tertiary ml-3">{t('bmad.resume.lastModified', { time: lastModifiedRelative })}</p>
      </div>
    );
  }

  // Normal resume workflow UI
  const buttonClass = clsx(
    'flex items-center gap-2 px-3 py-2 text-xs rounded-md transition-colors font-medium border',
    'focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2',
    {
      'bg-orange-500 hover:bg-orange-600 text-white border-orange-500': !loading,
      'opacity-50 cursor-not-allowed': loading,
    },
  );

  return (
    <div className="flex flex-col gap-1.5 p-3 border border-warning rounded-md bg-bg-secondary">
      {/* Header with workflow name and description */}
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-text-primary">{workflowName}</span>
            <span className="text-2xs bg-warning-subtle text-warning-text px-2 py-0.5 rounded">
              {t('bmad.resume.stepIndicator', { current: currentStep, total: totalSteps })}
            </span>
          </div>
          {workflow?.description && <p className="text-2xs text-text-secondary mt-1">{workflow.description}</p>}
        </div>
        <button
          onClick={handleResumeWorkflow}
          className={buttonClass}
          disabled={loading}
          aria-label={loading ? t('bmad.resume.resuming') : `${t('bmad.resume.button')} ${workflowName}`}
          aria-disabled={loading}
          type="button"
        >
          {loading ? <CgSpinner className="animate-spin w-4 h-4" /> : <FaPlayCircle className="w-4 h-4" />}
          <span>{loading ? t('bmad.resume.resuming') : t('bmad.resume.button')}</span>
        </button>
      </div>

      {/* File and last modified info */}
      <div className="flex items-center gap-3 pt-1.5 border-t border-border-dark-light text-2xs">
        {incompleteWorkflow.artifactPath && (
          <button
            onClick={handleOpenArtifact}
            className="flex items-center gap-1.5 text-accent-primary hover:text-accent-secondary transition-colors group"
            title={t('bmad.artifact.openFile')}
            type="button"
          >
            <FiFile className="w-3 h-3" />
            <span className="underline decoration-dotted underline-offset-2">{getFileName(incompleteWorkflow.artifactPath)}</span>
            <FiExternalLink className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 transition-opacity" />
          </button>
        )}
        <span className="text-text-tertiary">{t('bmad.resume.lastModified', { time: lastModifiedRelative })}</span>
      </div>
    </div>
  );
};
