import { cva } from 'class-variance-authority';
import { cn } from './cn.js';

// shadcn's structure — cva variants, `asChild`-less, forwarded props — with its
// visual layer replaced. Its defaults are neutral greys, soft shadows and 0.5rem
// radii; ours are plum on blush with full pill radii, so almost none of the
// original styling survives. What we keep is the part worth keeping: the variant
// API and the class-merge behaviour.
//
// The radius matches the selects and the rows at 3px. It was a 99px pill, which
// made the buttons the only round thing among a panel of square-cornered
// controls. The badges stay pills — a tag and a button are different objects,
// and only one of them is a control.
const button = cva(
  [
    'inline-flex items-center gap-2 whitespace-nowrap cursor-pointer',
    'font-sans text-[12.5px] leading-none rounded-[3px]',
    'transition-[background-color,color,border-color,transform] duration-150',
    'active:translate-y-px',
    'disabled:opacity-40 disabled:cursor-default disabled:active:translate-y-0',
    'focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2',
  ],
  {
    variants: {
      variant: {
        // Outline is the resting state for most controls here — the panel is
        // mostly quiet, and a page of filled buttons would flatten the hierarchy.
        outline: 'border-[1.5px] border-ink bg-paper text-ink hover:bg-wash hover:border-accent',
        primary: 'border-[1.5px] border-ink bg-ink text-paper hover:bg-accent hover:border-accent',
        // No border, no dimming: a quiet control here should read as quiet
        // because it lacks a frame, not because its ink is faded.
        ghost: 'border-[1.5px] border-transparent bg-transparent text-ink hover:bg-wash',
      },
      size: {
        default: 'px-5 py-[11px]',
        sm: 'px-[15px] py-[9px] label-caps tracking-[.1em]',
      },
    },
    defaultVariants: { variant: 'outline', size: 'default' },
  },
);

export function Button({ className, variant, size, ...props }) {
  return <button type="button" className={cn(button({ variant, size }), className)} {...props} />;
}

export { button as buttonVariants };
