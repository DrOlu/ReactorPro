import { RiAlertLine } from 'react-icons/ri';
import { useTranslation } from 'react-i18next';
import { TaskData } from '@common/types';

import { useBmadState } from './useBmadState';

import { SuggestedWorkflowCard } from '@/components/bmad/SuggestedWorkflowCard';

type Props = {
  projectDir: string;
  taskId: string;
  task?: TaskData | null;
};

export const BmadTaskActions = ({ projectDir, taskId, task }: Props) => {
  const { t } = useTranslation();
  const { status, suggestedWorkflows, error, refresh } = useBmadState({ projectDir, task });

  if (error) {
    return (
      <div className="p-2 max-w-full break-words text-xs border-t border-border-dark-light relative group bg-bg-primary-light-strong">
        <div className="flex items-center gap-2">
          <RiAlertLine className="h-4 w-4 flex-shrink-0 text-error" />
          <div className="flex-1 text-text-secondary">
            {t('bmad.taskActions.error')}: {error}
          </div>
        </div>
      </div>
    );
  }

  if (!status) {
    return null;
  }

  const hasCompletedWorkflows = status.completedWorkflows.length > 0;

  const suggestedWorkflowMetadata = hasCompletedWorkflows
    ? status.availableWorkflows.filter((workflow) => suggestedWorkflows.includes(workflow.id) && !status.inProgressWorkflows.includes(workflow.id))
    : [];

  if (suggestedWorkflowMetadata.length === 0) {
    return null;
  }

  return (
    <div className="p-2 px-4 max-w-full break-words text-xs border-t border-border-dark-light relative group bg-bg-primary-light-strong">
      <div className="flex flex-col gap-1.5">
        <h4 className="text-2xs font-semibold text-text-secondary">{t('bmad.taskActions.workflowsSection')}</h4>
        <div className="flex flex-wrap gap-2">
          {suggestedWorkflowMetadata.map((workflow) => (
            <SuggestedWorkflowCard key={workflow.id} workflow={workflow} projectDir={projectDir} taskId={taskId} onRefresh={refresh} />
          ))}
        </div>
      </div>
    </div>
  );
};
