import {Switch, Flex } from '@chakra-ui/react';
import * as React from 'react';

type ThemeSwitchProps = {
  switchOn: boolean;
  setSwitchOn: (isSwitchOn: boolean) => void;
}

const ThemeSwitch = ({ switchOn, setSwitchOn }: ThemeSwitchProps) => {
  const handleSwitchChange = (event: React. ChangeEvent<HTMLInputElement>) => {
    if (event.target.checked) {
      setSwitchOn(true);
    } else {
      setSwitchOn(false);
    }
  }
  return (
    <Flex position="absolute" left="10px" top="110px" padding="10px" flexDirection="column">
      <Switch isChecked={switchOn} onChange={handleSwitchChange} size='lg' />
    </Flex>
  );
};

export default ThemeSwitch;