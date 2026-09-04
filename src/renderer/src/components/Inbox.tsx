import { type InboxProps, useInboxController } from '../hooks/useInboxController'
import { ToastContext } from '../toastContext'
import { InboxLayout } from './InboxLayout'

export function Inbox(props: InboxProps): React.JSX.Element {
  const controller = useInboxController(props)

  return (
    <ToastContext.Provider value={controller.showToast}>
      <InboxLayout controller={controller} />
    </ToastContext.Provider>
  )
}
