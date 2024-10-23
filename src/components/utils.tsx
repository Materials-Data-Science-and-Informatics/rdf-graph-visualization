const groupColors: { [key: string]: string } = {
  person: "red",
  dataset: "blue",
  organization: "green",
  software: "yellow",
  document: "orange",
  article: "indigo",
  creativeWork: "violet",
  service: "cyan",
  "": "gray", // Default group
};

const groups = Object.keys(groupColors).filter((group) => group !== ""); // Remove the default group

const getGroupColor = (group: string) => {
  return groupColors[group] || "gray"; // Default to gray if group not found
};

export { groups, getGroupColor, groupColors };
