import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export default function InfoDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="About">
          <Info />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>HKG Graph Explorer</DialogTitle>
          <DialogDescription>
            A live, GPU-accelerated 3D/2D view of the Helmholtz Knowledge Graph. Search for an
            entity, explore its neighbourhood as it streams in, and click nodes for details.
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
