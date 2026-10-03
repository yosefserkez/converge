import { Dialog as SheetPrimitive } from '@base-ui/react/dialog';
import { XIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '../../lib/utils.ts';

// shadcn Sheet on the Base UI Dialog primitive. It opens from the right on wide
// screens and fills the screen on phones.

function Sheet(props: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

/** Opens the sheet. Use it instead of an onClick that sets `open`: it keeps a touch tap from closing the sheet again. */
function SheetTrigger(props: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: SheetPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Backdrop
        data-slot="sheet-overlay"
        className="fixed inset-0 z-50 bg-black/30 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0"
      />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-background shadow-xl outline-none transition-transform duration-200 ease-out data-ending-style:translate-x-full data-starting-style:translate-x-full sm:max-w-2xl',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            className="absolute top-3 right-3 inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="sheet-header" className={cn('flex flex-col gap-1 border-b px-5 py-4 pr-12', className)} {...props} />;
}

function SheetBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="sheet-body" className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4', className)} {...props} />;
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return <SheetPrimitive.Title data-slot="sheet-title" className={cn('text-base font-semibold', className)} {...props} />;
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return <SheetPrimitive.Description data-slot="sheet-description" className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger };
