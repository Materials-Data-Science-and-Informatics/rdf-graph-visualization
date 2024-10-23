import {  FormControl, FormLabel, Switch } from "@chakra-ui/react";
import * as React from "react";

interface FilterSwitchProps {
  name: string;
  filters: Set<string>;
  setFilters: React.Dispatch<React.SetStateAction<Set<string>>>;
}

const FilterSwitch = ({name,filters,setFilters}:FilterSwitchProps) => {
  const isChecked = filters.has(name);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.checked) {
      setFilters(new Set(filters).add(name));
    } else {
      filters.delete(name);
      setFilters(new Set(filters));
    }
  }

  return (
    <FormControl>
      <FormLabel htmlFor={`filter-${name}`}>{name}</FormLabel>
      <Switch isChecked={isChecked} onChange={handleChange} id={`filter-${name}`} />
    </FormControl>
  )
}

export default  FilterSwitch;