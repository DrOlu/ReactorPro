import { useCallback, useMemo, useState, startTransition, useOptimistic } from 'react';
import { HiChevronLeft, HiChevronRight } from 'react-icons/hi';
import { useTranslation } from 'react-i18next';
import { useHotkeys } from 'react-hotkeys-hook';
import { DiffViewMode, UpdatedFile } from '@common/types';
import { getLanguageFromPath } from '@common/utils';
import { clsx } from 'clsx';

import { IconButton } from '../common/IconButton';
import { ModalOverlayLayout } from '../common/ModalOverlayLayout';
import { UDiffViewer, CompactDiffViewer } from '../common/DiffViewer';
import { CompactSelect } from '../common/CompactSelect';

import { useSettings } from '@/contexts/SettingsContext';

type Props = {
  files: UpdatedFile[];
  initialFileIndex: number;
  onClose: () => void;
};

export const UpdatedFilesDiffModal = ({ files, initialFileIndex, onClose }: Props) => {
  const { t } = useTranslation();
  const { settings, saveSettings } = useSettings();
  const [currentIndex, setCurrentIndex] = useState(initialFileIndex);
  const [diffViewMode, setDiffViewMode] = useOptimistic(settings?.diffViewMode || DiffViewMode.SideBySide);

  const currentFile = files[currentIndex];

  const language = useMemo(() => {
    return currentFile?.path ? getLanguageFromPath(currentFile.path) : 'text';
  }, [currentFile]);

  const handlePrevious = useCallback(() => {
    setCurrentIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const handleNext = useCallback(() => {
    setCurrentIndex((prev) => Math.min(files.length - 1, prev + 1));
  }, [files.length]);

  const handleDiffViewModeChange = useCallback(
    (value: string) => {
      if (settings) {
        startTransition(() => {
          setDiffViewMode(value as DiffViewMode);
          void saveSettings({
            ...settings,
            diffViewMode: value as DiffViewMode,
          });
        });
      }
    },
    [settings, saveSettings, setDiffViewMode],
  );

  const diffViewOptions = useMemo(
    () => [
      { label: t('diffViewer.sideBySide'), value: DiffViewMode.SideBySide },
      { label: t('diffViewer.unified'), value: DiffViewMode.Unified },
      { label: t('diffViewer.compact'), value: DiffViewMode.Compact },
    ],
    [t],
  );

  const canGoPrevious = currentIndex > 0;
  const canGoNext = currentIndex < files.length - 1;

  useHotkeys('left', handlePrevious, { enabled: canGoPrevious });
  useHotkeys('right', handleNext, { enabled: canGoNext });

  if (!currentFile) {
    return null;
  }

  return (
    <ModalOverlayLayout title={t('contextFiles.updatedFiles')} onClose={onClose} closeOnEscape={true}>
      <div className="flex items-center border-b border-border-default justify-center bg-bg-secondary min-h-[44px] px-4">
        <div className="flex items-center justify-between w-full max-w-6xl">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-3xs sm:text-xs font-medium text-text-primary truncate" title={currentFile.path}>
              {currentFile.path}
            </span>
            {currentFile.additions > 0 && <span className="text-3xs sm:text-xs font-medium text-success shrink-0">+{currentFile.additions}</span>}
            {currentFile.deletions > 0 && <span className="text-3xs sm:text-xs font-medium text-error shrink-0">-{currentFile.deletions}</span>}
          </div>
          <div className="flex items-center gap-3 shrink-0 ml-4">
            <div className="hidden sm:block">
              <CompactSelect options={diffViewOptions} value={diffViewMode} onChange={handleDiffViewModeChange} />
            </div>
            {files.length > 1 && (
              <div className="flex items-center gap-2">
                <IconButton
                  icon={<HiChevronLeft className="h-5 w-5" />}
                  onClick={handlePrevious}
                  tooltip={t('common.previous')}
                  disabled={!canGoPrevious}
                  className={clsx(
                    'p-1.5 rounded-md transition-colors',
                    canGoPrevious ? 'hover:bg-bg-tertiary text-text-secondary' : 'text-text-muted cursor-not-allowed',
                  )}
                />
                <span className="text-xs sm:text-sm text-text-secondary min-w-[60px] text-center">
                  {currentIndex + 1} / {files.length}
                </span>
                <IconButton
                  icon={<HiChevronRight className="h-5 w-5" />}
                  onClick={handleNext}
                  tooltip={t('common.next')}
                  disabled={!canGoNext}
                  className={clsx(
                    'p-1.5 rounded-md transition-colors',
                    canGoNext ? 'hover:bg-bg-tertiary text-text-secondary' : 'text-text-muted cursor-not-allowed',
                  )}
                />
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4 bg-bg-primary-light scrollbar scrollbar-thumb-bg-tertiary scrollbar-track-transparent">
        <div className="max-w-6xl mx-auto select-text bg-bg-code-block rounded-lg p-4 text-xs">
          {diffViewMode === DiffViewMode.Compact ? (
            <CompactDiffViewer udiff={currentFile.diff || ''} language={language} showFilename={false} />
          ) : (
            <UDiffViewer udiff={currentFile.diff || ''} language={language} viewMode={diffViewMode} showFilename={false} />
          )}
        </div>
      </div>
    </ModalOverlayLayout>
  );
};
