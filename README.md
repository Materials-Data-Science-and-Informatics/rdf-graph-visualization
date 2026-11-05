# RDF Graph Visualization

> [!WARNING]
> 🚧 **In development**
>
> This project is currently developed primarily for internal use. The public [GraphViz deployment](https://graphviz.unhide.helmholtz-metadaten.de/) is adapted to the Helmholtz KG internal data model, which limits its flexibility for other use cases.
>
> We are aware of this limitation and are considering further development toward a more flexible GraphViz solution.

## Description
This project is a TypeScript/React application that fetches bounded graph slices as typed JSON from a backend API and renders them as a 3D force-directed graph.

The backend resolves the data model (types, groups, labels, relations) and serves pre-filtered, paginated slices, so the frontend stays a thin, typed client.

## Features
- Fetches a bounded, cursor-paginated graph slice as typed JSON (cancellable fetch with per-endpoint timeouts).
- Creates nodes and edges for a 3D force-directed representation.
- Filters and displays nodes based on user-selected criteria.

## Installation
1. Clone the repository.

```bash
git clone https://github.com/Materials-Data-Science-and-Informatics/rdf-graph-visualization.git
```
2. Install dependencies:

```bash
npm install
```

3. Create the `config.yml` file in the root directory and set it according to next section.
4. You can run the application with:

```bash
npm run dev
```

5. Or you can build the application with below command and serve it with a web server.

```bash
npm run build
```

Git hooks (ruff, mypy, pylint, eslint, prettier, reuse, somesy; tests on push) are managed by pre-commit. Install once with:

```bash
uvx pre-commit install
```

The app talks to the backend API under `/api` (typed JSON, see `frontend/src/api/`).
In development Vite proxies `/api` to `http://127.0.0.1:8000` (override with
`API_PROXY_TARGET`); the Docker image proxies the same path via nginx.

## Configuration
Configuration file has the necessary information to show nodes and links in the graph. Since a 3D graph on the browser consumes a lot of resources, it is important to filter the data to show only the necessary information. Properties that are not in the yaml file will be ignored. You can check [example config file](examples/config.yml) for more information.

The configuration file is a YAML file that has the following properties:
```yaml
# links will be created from these properties
relationProperties:
  - "http://schema.org/affiliation"

# labels will be created from these properties
labelProperties:
  - "http://schema.org/name"

# groups will be created from these properties
groups:
  - name: 'Organization'
    types:
      - 'http://schema.org/Organization'
    properties:
        - 'http://schema.org/affiliation'
    color: '#FF0000'
```

- `relationProperties`: List of properties that will be used to create links between nodes.
- `labelProperties`: List of properties that will be used to create labels for nodes.
- `groups`: List of groups that will be created based on the properties. Each group has the following properties:
  - `name`: Name of the group.
  - `types`: List of types that will be included in the group.
  - `properties`: List of properties that will be used to filter the data. **Can be empty.**
  - `color`: Color of the group. Please use HEX color codes.

## URL parameters

The explorer can be opened with its settings in the query string. URL values apply to that visit only (they are not saved) and override saved settings; invalid values are ignored or clamped.

| Parameter | Meaning |
| --------- | ------- |
| `root`    | IRI (http/https) of the starting node |
| `nodes`   | Number of nodes shown (500 to 100000) |
| `depth`   | Maximum hops from the root (1 to 8) |
| `fanout`  | Connections per node (0 = no cap) |
| `dim`     | `2` or `3` |
| `select`  | IRI of a node whose details card opens once it is in the shown window |

Example: `/?root=https%3A%2F%2Fexample.org%2Fa&depth=3&dim=2&select=https%3A%2F%2Fexample.org%2Fb`

## How to Cite

If you want to cite this project in your scientific work,
please use the [citation file](https://citation-file-format.github.io/)
in the [repository](https://github.com/Materials-Data-Science-and-Informatics/rdf-graph-visualization/blob/main/CITATION.cff).

## Acknowledgements

We kindly thank all authors and contributors.

### Third-party Libraries

This project uses the following open-source libraries:

- **react-force-graph-3d** by Vasco Asturiano - MIT License
  - Repository: [react-force-graph](https://github.com/vasturiano/react-force-graph)
  - A React component for 3D force directed graphs using ThreeJS/WebGL

### Funding

This project was developed at the Institute for Materials Data Science and Informatics
(IAS-9) of the Jülich Research Center and funded by the Helmholtz Metadata Collaboration
(HMC), an incubator-platform of the Helmholtz Association within the framework of the
Information and Data Science strategic initiative.

<div>
<img style="vertical-align: middle;" alt="HMC Logo" src="https://github.com/Materials-Data-Science-and-Informatics/Logos/raw/main/HMC/HMC_Logo_M.png" width=50% height=50% />
&nbsp;&nbsp;
<img style="vertical-align: middle;" alt="FZJ Logo" src="https://github.com/Materials-Data-Science-and-Informatics/Logos/raw/main/FZJ/FZJ.png" width=30% height=30% />
</div>
<br />
