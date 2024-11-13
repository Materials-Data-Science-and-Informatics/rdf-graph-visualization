import { FormControl, FormLabel, Switch } from "@chakra-ui/react";
import * as React from "react";

interface FilterSwitchProps {
  name: string;
  filters: Set<string>;
  setFilters: React.Dispatch<React.SetStateAction<Set<string>>>;
  count?: number;
}

const FilterSwitch = ({ name, filters, setFilters, count }: FilterSwitchProps) => {
  const isChecked = !filters.has(name);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.checked) {
      setFilters(new Set(filters).add(name));
    } else {
      filters.delete(name);
      setFilters(new Set(filters));
    }
  };

  const title = () => {
    if (count) {
      return `${name} (${count})`;
    }
    return `${name} (0)`;
  };

  return (
    <FormControl>
      <FormLabel fontSize='lg' htmlFor={`filter-${name}`}>{title()}</FormLabel>
      <Switch isChecked={isChecked} onChange={handleChange} id={`filter-${name}`} />
    </FormControl>
  );
};

export default FilterSwitch;
