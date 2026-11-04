import { Switch } from "@/components/ui/switch";

type ThemeSwitchProps = {
  switchOn: boolean;
  setSwitchOn: (isSwitchOn: boolean) => void;
};

const ThemeSwitch = ({ switchOn, setSwitchOn }: ThemeSwitchProps) => {
  return (
    <div className="absolute left-[10px] top-[110px] p-[10px]">
      <Switch
        checked={switchOn}
        onCheckedChange={(checked) => setSwitchOn(checked)}
        aria-label="Toggle light theme"
      />
    </div>
  );
};

export default ThemeSwitch;
