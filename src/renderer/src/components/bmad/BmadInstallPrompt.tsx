import { useState, MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FiTerminal, FiCheck, FiPackage } from 'react-icons/fi';
import { clsx } from 'clsx';

import { useApi } from '@/contexts/ApiContext';
import { showErrorNotification } from '@/utils/notifications';
import { Button } from '@/components/common/Button';
import { CopyMessageButton } from '@/components/message/CopyMessageButton';

type Props = {
  projectDir: string;
  taskId: string;
  onOpenTerminal: () => void;
};

export const BmadInstallPrompt = ({ projectDir, taskId, onOpenTerminal }: Props) => {
  const { t } = useTranslation();
  const api = useApi();
  const [opening, setOpening] = useState(false);

  const installCommand = 'npx -y bmad-method install';

  const handleInstall = async (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setOpening(true);

    try {
      await api.createTerminal(projectDir, taskId, 160, 40);

      setTimeout(async () => {
        try {
          const terminals = await api.getAllTerminalsForTask(taskId);
          if (terminals.length > 0) {
            const terminalId = terminals[terminals.length - 1].id;
            await api.writeToTerminal(terminalId, `${installCommand}\r`);
          }
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error('Failed to write command to terminal:', error);
        }
      }, 300);

      onOpenTerminal();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showErrorNotification(`${t('bmad.install.terminalError')}: ${errorMessage}`);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center py-8">
      <div className="w-full max-w-lg">
        <div className="flex flex-col items-center mb-6">
          <div className="w-12 h-12 rounded-xl bg-button-primary-subtle flex items-center justify-center mb-4">
            <FiPackage className="w-6 h-6 text-button-primary" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary mb-2">{t('bmad.welcome.title')}</h2>
          <p className="text-sm text-text-secondary text-center">{t('bmad.welcome.subtitle')}</p>
        </div>

        <div className="bg-bg-secondary rounded-lg border border-border-dark-light p-4 mb-4">
          <p className="text-xs text-text-tertiary mb-3 font-medium">{t('bmad.install.terminalPrompt')}</p>
          <ul className="space-y-2">
            {(t('bmad.install.benefits', { returnObjects: true }) as string[]).map((benefit, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <div className="w-4 h-4 rounded-full bg-success-subtle flex items-center justify-center flex-shrink-0 mt-0.5">
                  <FiCheck className="w-2.5 h-2.5 text-success" />
                </div>
                <span className="text-xs text-text-secondary">{benefit}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-bg-tertiary rounded-lg border border-border-dark-light p-3 mb-4">
          <p className="text-xs text-text-tertiary mb-2">{t('bmad.install.commandLabel')}</p>
          <div className="group flex items-center justify-between gap-2 bg-bg-primary rounded-md px-3 py-2">
            <code className="text-xs text-text-primary font-mono">{installCommand}</code>
            <CopyMessageButton content={installCommand} alwaysShow />
          </div>
        </div>

        <div className="flex justify-center">
          <Button onClick={handleInstall} disabled={opening} size="sm">
            <FiTerminal className={clsx('w-4 h-4 mr-2', opening && 'animate-pulse')} />
            {opening ? t('bmad.install.opening') : t('bmad.install.openTerminal')}
          </Button>
        </div>

        <p className="text-xs text-text-muted-light text-center mt-4">{t('bmad.install.autoCheckNote')}</p>
      </div>
    </div>
  );
};
