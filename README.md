# RDF Graph Visualization

## Description
This project is a TypeScript/JavaScript application that processes RDF data to create a graph representation. It uses React for the frontend and Chakra UI for styling.

We strongly suggest users to use `turtle for`mat for RDF data and `schema.org` vocabulary for the properties. The application is designed to work with the `schema.org` vocabulary, since we developed it for a specific use case. However, it can be easily modified to work with other vocabularies.

## Features
- Parses RDF data and filters relevant properties.
- Creates nodes and edges for a graph representation.
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

## Configuration
Configuration file has the necessary information to show nodes and links in the graph. Since a 3D graph on the browser consumes a lot of resources, it is important to filter the data to show only the necessary information.

The configuration file is a YAML file that has the following properties:
```yaml
# parsing will skip all properties that are not in the list of relevantProperties
relevantProperties:
  - "http://schema.org/name"
  - "http://schema.org/affiliation"
  - "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"

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

- `relevantProperties`: List of properties that will be used to filter the data.
- `relationProperties`: List of properties that will be used to create links between nodes.
- `labelProperties`: List of properties that will be used to create labels for nodes.
- `groups`: List of groups that will be created based on the properties. Each group has the following properties:
  - `name`: Name of the group.
  - `types`: List of types that will be included in the group.
  - `properties`: List of properties that will be used to filter the data. **Can be empty.**
  - `color`: Color of the group. Please use HEX color codes.

## How to Cite

If you want to cite this project in your scientific work,
please use the [citation file](https://citation-file-format.github.io/)
in the [repository](https://github.com/Materials-Data-Science-and-Informatics/rdf-graph-visualization/blob/main/CITATION.cff).

<!-- --8<-- [end:citation] -->
<!-- --8<-- [start:acknowledgements] -->

## Acknowledgements

We kindly thank all authors and contributors.

<div>
<img style="vertical-align: middle;" alt="HMC Logo" src="https://github.com/Materials-Data-Science-and-Informatics/Logos/raw/main/HMC/HMC_Logo_M.png" width=50% height=50% />
&nbsp;&nbsp;
<img style="vertical-align: middle;" alt="FZJ Logo" src="https://github.com/Materials-Data-Science-and-Informatics/Logos/raw/main/FZJ/FZJ.png" width=30% height=30% />
</div>
<br />

This project was developed at the Institute for Materials Data Science and Informatics
(IAS-9) of the Jülich Research Center and funded by the Helmholtz Metadata Collaboration
(HMC), an incubator-platform of the Helmholtz Association within the framework of the
Information and Data Science strategic initiative.