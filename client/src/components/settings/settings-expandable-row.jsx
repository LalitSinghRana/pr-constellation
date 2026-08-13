import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.jsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item.jsx";

export function SettingsExpandableRow({ id, title, description, open, onOpenChange, children }) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <Item size="sm" className="flex-col items-stretch rounded-none border-0 px-0 py-0">
        <CollapsibleTrigger
          className="group flex w-full items-center gap-4 px-5 py-4 text-left outline-none hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
          id={id}
        >
          <ItemContent>
            <ItemTitle>{title}</ItemTitle>
            <ItemDescription className="line-clamp-none">{description}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <ChevronDown
              aria-hidden="true"
              className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
            />
          </ItemActions>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden">
          <div className="border-t px-5 py-4">{children}</div>
        </CollapsibleContent>
      </Item>
    </Collapsible>
  );
}
