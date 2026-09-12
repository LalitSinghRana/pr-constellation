import { cva } from "class-variance-authority";
import { ChevronDown } from "lucide-react";
import { Slot } from "radix-ui";
import { CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const itemGroupCardClassName =
  "gap-0 overflow-hidden rounded-lg border bg-card/75 shadow-lg backdrop-blur-sm";
const itemListRowClassName =
  "rounded-none border-0 border-b border-border p-5 last:border-b-0 hover:bg-accent/50";

function ItemGroup({ className, ...props }) {
  return (
    <div
      data-slot="item-group"
      className={cn("group/item-group flex flex-col", className)}
      {...props}
    />
  );
}

function ItemGroupHeader({ className, ...props }) {
  return (
    <header
      data-slot="item-group-header"
      className={cn(
        "flex min-h-[2.8rem] items-center justify-between gap-4 border-b bg-accent/78 px-[1.2rem] py-[0.65rem] max-[700px]:px-[0.9rem]",
        className,
      )}
      {...props}
    />
  );
}

function ItemSeparator({ className, ...props }) {
  return (
    <Separator
      data-slot="item-separator"
      orientation="horizontal"
      className={cn("my-0", className)}
      {...props}
    />
  );
}

const itemVariants = cva(
  "group/item flex flex-wrap items-center rounded-md border border-transparent text-sm transition-colors duration-100 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [a]:transition-colors [a]:hover:bg-accent/50",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border-border",
        muted: "bg-muted/50",
      },
      size: {
        default: "gap-4 p-4",
        sm: "gap-2.5 px-4 py-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Item({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ref,
  ...props
}) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      ref={ref}
      data-slot="item"
      data-variant={variant}
      data-size={size}
      className={cn(itemVariants({ variant, size, className }))}
      {...props}
    />
  );
}

const itemMediaVariants = cva(
  "flex shrink-0 items-center justify-center gap-2 group-has-[[data-slot=item-description]]/item:translate-y-0.5 group-has-[[data-slot=item-description]]/item:self-start [&_svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "size-8 rounded-sm border bg-muted [&_svg:not([class*='size-'])]:size-4",
        image: "size-10 overflow-hidden rounded-sm [&_img]:size-full [&_img]:object-cover",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function ItemMedia({ className, variant = "default", ...props }) {
  return (
    <div
      data-slot="item-media"
      data-variant={variant}
      className={cn(itemMediaVariants({ variant, className }))}
      {...props}
    />
  );
}

function ItemContent({ className, ...props }) {
  return (
    <div
      data-slot="item-content"
      className={cn("flex flex-1 flex-col gap-1 [&+[data-slot=item-content]]:flex-none", className)}
      {...props}
    />
  );
}

function ItemTitle({ className, ...props }) {
  return (
    <div
      data-slot="item-title"
      className={cn("flex w-fit items-center gap-2 text-sm leading-snug font-medium", className)}
      {...props}
    />
  );
}

function ItemDescription({ className, ...props }) {
  return (
    <p
      data-slot="item-description"
      className={cn(
        "line-clamp-2 text-sm leading-normal font-normal text-balance text-muted-foreground",
        "[&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
        className,
      )}
      {...props}
    />
  );
}

function ItemActions({ className, ...props }) {
  return (
    <div data-slot="item-actions" className={cn("flex items-center gap-2", className)} {...props} />
  );
}

function ItemHeader({ className, ...props }) {
  return (
    <div
      data-slot="item-header"
      className={cn("flex basis-full items-center justify-between gap-2", className)}
      {...props}
    />
  );
}

function ItemFooter({ className, ...props }) {
  return (
    <div
      data-slot="item-footer"
      className={cn("flex basis-full items-center justify-between gap-2", className)}
      {...props}
    />
  );
}

function ItemTrigger({ className, ...props }) {
  return (
    <CollapsibleTrigger
      aria-label="Show details"
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&[data-state=open]>svg]:rotate-180",
        className,
      )}
      {...props}
    >
      <ChevronDown aria-hidden="true" className="size-4 transition-transform" />
    </CollapsibleTrigger>
  );
}

function ItemPanel({ className, ...props }) {
  return (
    <CollapsibleContent
      data-slot="item-panel"
      className={cn("basis-full overflow-hidden", className)}
      {...props}
    />
  );
}

ItemGroup.Header = ItemGroupHeader;
Item.Media = ItemMedia;
Item.Content = ItemContent;
Item.Actions = ItemActions;
Item.Trigger = ItemTrigger;
Item.Panel = ItemPanel;

export {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemGroupHeader,
  ItemHeader,
  ItemMedia,
  ItemPanel,
  ItemSeparator,
  ItemTitle,
  ItemTrigger,
  itemGroupCardClassName,
  itemListRowClassName,
};
