import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '~/utils';

/**
 * Click-to-open popover for the sidebar icon-strip status buttons: a compact
 * icon trigger with the panel anchored above it. Closes on outside pointer
 * down or Escape; focus stays on the trigger (the panel is not a dialog).
 */
export default function StatusPopover({
  label,
  trigger,
  triggerClassName,
  panelClassName,
  children,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  panelClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={label}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-surface-hover',
          triggerClassName,
        )}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
      </button>
      {open && (
        <div
          className={cn(
            'absolute bottom-full left-0 z-50 mb-2 flex w-64 flex-col gap-2 rounded-lg border border-border-medium bg-surface-primary p-3 text-xs shadow-lg',
            panelClassName,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}
