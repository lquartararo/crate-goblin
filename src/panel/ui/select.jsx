import * as SelectPrimitive from '@radix-ui/react-select';
import { cn } from './cn.js';

// Radix rather than a native <select>, for the one thing native can't do: a
// styled dropdown. Native option lists are drawn by the OS and ignore the
// page's fonts and colours entirely, so on a panel built around Redaction and
// plum the open menu was always going to look like it belonged to something
// else. Radix also brings the keyboard and focus behaviour we'd otherwise
// hand-roll — type-ahead, arrow navigation, focus return on close.

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

/** A small caret drawn as pixel cells, matching the icon set. */
const Caret = () => (
  <svg viewBox="0 0 12 12" width="10" height="10" fill="currentColor"
       shapeRendering="crispEdges" aria-hidden="true">
    <rect x="2" y="4" width="2" height="2" /><rect x="4" y="6" width="2" height="2" />
    <rect x="6" y="4" width="2" height="2" />
  </svg>
);

export function SelectTrigger({ className, children, ...props }) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'inline-flex items-center justify-between gap-3 cursor-pointer',
        'px-3 py-[10px] rounded-[3px] border-[1.5px] border-ink bg-paper text-ink',
        'font-sans text-[13px] leading-none',
        'transition-colors duration-150 hover:border-accent',
        'focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1',
        'data-[placeholder]:opacity-60',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon><Caret /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({ className, children, ...props }) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        // `position="popper"` so the menu sits below the trigger rather than
        // overlaying it; in a narrow side panel an overlaying menu covers the
        // label you just read.
        position="popper"
        sideOffset={4}
        className={cn(
          'z-50 overflow-hidden rounded-[3px] border-[1.5px] border-ink bg-paper',
          'min-w-[var(--radix-select-trigger-width)]',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex cursor-pointer select-none items-center rounded-[2px]',
        'px-2.5 py-2 font-sans text-[13px] leading-none outline-none',
        'data-[highlighted]:bg-wash data-[state=checked]:bg-accent data-[state=checked]:text-paper',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
