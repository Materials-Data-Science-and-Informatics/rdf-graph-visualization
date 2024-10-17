import "./App.css";
import Graph from "./Graph.tsx";
import { ChakraProvider } from '@chakra-ui/react'

function App() {
  return (
    <ChakraProvider>
      <h1>RDF Graph Visualization</h1>
      <Graph />
    </ChakraProvider>
  );
}

export default App;
