import { IMPORTANT_SPLIT_ID, OTHER_SPLIT_ID } from '../../../shared/splits'
import { Composer } from '../composer/Composer'
import type { InboxController } from '../hooks/useInboxController'
import { LabelPicker } from '../LabelPicker'
import { MovePicker } from '../MovePicker'
import { CheatSheet } from './CheatSheet'
import { CommandPalette } from './CommandPalette'
import { SnoozePicker } from './SnoozePicker'
import { SplitRuleManager } from './SplitRuleManager'
import { Toast } from './Toast'

export function InboxOverlays({ controller: c }: { controller: InboxController }): React.JSX.Element {
  return (
    <>
      {!c.composerDraft && c.snoozeOpen && c.selected && (
        <SnoozePicker
          targetCount={c.targetedThreads.length}
          onCancel={c.closeSnooze}
          onConfirm={c.snoozeSelected}
          onUnsnooze={c.view === 'snoozed' ? c.unsnoozeSelected : undefined}
        />
      )}
      {!c.composerDraft && c.labelTargets && (
        <LabelPicker
          labels={c.labels}
          targets={c.labelTargets.map((target) => ({ id: target.id, labelIds: target.labelIds }))}
          onClose={c.closeLabel}
          onToggle={c.toggleLabel}
        />
      )}
      {!c.composerDraft && c.moveRequest && (
        <MovePicker
          labels={c.labels}
          targets={c.moveRequest.targets}
          sourceLabelId={c.moveRequest.sourceLabelId}
          showImportanceActions={Boolean(
            !c.searchOpen &&
              c.view === 'inbox' &&
              c.splits.state?.splits.some((split) => split.id === IMPORTANT_SPLIT_ID) &&
              c.splits.state.splits.some((split) => split.id === OTHER_SPLIT_ID)
          )}
          onClose={c.closeMove}
          onMove={c.moveSelected}
        />
      )}
      {!c.composerDraft && c.splitRulesOpen && c.splits.state && (
        <SplitRuleManager
          state={c.splits.state}
          onSave={c.splits.save}
          onNotify={c.splits.setNotify}
          onDelete={c.splits.remove}
          onReorder={(ids) => c.splits.reorder({ ids })}
          onRestore={c.splits.restorePreset}
          onClose={() => c.setSplitRulesOpen(false)}
        />
      )}
      <CommandPalette
        account={c.activeAccount}
        context={
          c.composerDraft ? 'composer' : c.readerOpen ? 'reader' : c.view === 'outbox' ? 'outbox' : 'list'
        }
        onOpenChange={c.setPaletteOpen}
      />
      <CheatSheet
        open={c.cheatSheetOpen}
        paletteOpen={c.paletteOpen}
        onOpen={c.openCheatSheet}
        onClose={c.closeCheatSheet}
      />
      {c.fullWindowComposerDraft && c.activeAccount && (
        <Composer
          draft={c.fullWindowComposerDraft}
          initialError={c.composerError}
          onClose={c.drafting.closeComposer}
          onToast={c.showToast}
        />
      )}
      <Toast toast={c.toast} progress={c.outboxProgress} />
    </>
  )
}
