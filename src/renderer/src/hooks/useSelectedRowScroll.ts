import { useLayoutEffect } from 'react'

export function useSelectedRowScroll(
  selectedRowRef: React.RefObject<HTMLDivElement | null>,
  selectedIndex: number,
  readerOpen: boolean
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: triggers restore the cursor after reader navigation
  useLayoutEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedIndex, readerOpen])
}
