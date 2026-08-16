import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * shadcn's class merger. clsx flattens conditionals; twMerge resolves Tailwind
 * conflicts so a caller's `px-6` actually beats a component's default `px-4`
 * rather than depending on stylesheet order.
 */
export const cn = (...inputs) => twMerge(clsx(inputs));
