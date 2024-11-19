import {
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalCloseButton,
  Text,
  Box,
} from "@chakra-ui/react";

type TextModalProps = {
  isOpen: boolean;
  onClose: () => void;
  text: string;
};

const TextModal = ({ isOpen, onClose, text }: TextModalProps) => {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>YAML Config File</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <Box
            bg="gray.50"
            p={4}
            borderRadius="md"
            whiteSpace="pre-wrap"
            fontFamily="monospace"
            overflow="auto"
            maxH="75vh"
          >
            <Text>{text}</Text>
          </Box>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
};

export default TextModal;
