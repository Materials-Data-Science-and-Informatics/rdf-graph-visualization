import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type TextModalProps = {
  isOpen: boolean;
  onClose: () => void;
  text: string;
  title?: string;
};

const TextModal = ({ isOpen, onClose, text, title }: TextModalProps) => {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[35.5rem]">
        <DialogHeader>
          <DialogTitle>{title || "YAML Config File"}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[75vh] overflow-auto rounded-[6px] bg-gray-50 p-4 font-mono whitespace-pre-wrap dark:bg-gray-950">
          {text}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default TextModal;
