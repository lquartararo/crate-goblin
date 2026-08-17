import { cn } from './cn.js';

/**
 * A control with a caps label above it.
 *
 * A label element rather than a div, so the caption is part of the control's
 * hit area — the selects here are Radix triggers, and clicking their label
 * opens them the way a native one would.
 */
export function Field({ label, children, className = '' }) {
  return (
    <label className={cn('grid gap-[7px]', className)}>
      <span className="label-caps opacity-80">{label}</span>
      {children}
    </label>
  );
}
