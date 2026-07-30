import type { ComponentChildren, JSX } from "preact";

type IconProps = Omit<JSX.IntrinsicElements["svg"], "children"> & {
  children?: ComponentChildren;
};

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 7.5 8 2.5l5.5 5" />
      <path d="M4 7v6.5h8V7" />
    </Icon>
  );
}

export function BoardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="2.5" width="3.2" height="11" rx="0.6" />
      <rect x="6.4" y="2.5" width="3.2" height="7" rx="0.6" />
      <rect x="10.8" y="2.5" width="3.2" height="9" rx="0.6" />
    </Icon>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5.5" cy="5" r="2.2" />
      <path d="M1.8 13.5c0-2 1.7-3.6 3.7-3.6s3.7 1.6 3.7 3.6" />
      <circle cx="11.2" cy="5.4" r="1.8" />
      <path d="M10.6 9.9c2 .2 3.6 1.7 3.6 3.6" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.3" />
      <path d="M8 2v1.8M8 12.2V14M2 8h1.8M12.2 8H14M3.8 3.8l1.3 1.3M10.9 10.9l1.3 1.3M12.2 3.8l-1.3 1.3M5.1 10.9l-1.3 1.3" />
    </Icon>
  );
}


export function ScheduleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.2" />
      <path d="M5 2.5v2M11 2.5v2M2.5 6.5h11M6 9h2.5M6 11h4" />
    </Icon>
  );
}

export function ListIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </Icon>
  );
}

export function CardsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="2" width="5.2" height="5.2" rx="0.8" />
      <rect x="8.8" y="2" width="5.2" height="5.2" rx="0.8" />
      <rect x="2" y="8.8" width="5.2" height="5.2" rx="0.8" />
      <rect x="8.8" y="8.8" width="5.2" height="5.2" rx="0.8" />
    </Icon>
  );
}

export function GroupIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="5" width="8" height="8.5" rx="1" />
      <path d="M5.5 5V3.5a1 1 0 0 1 1-1H13a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1h-1.5" />
    </Icon>
  );
}

export function GraphIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="3" cy="8" r="1.3" />
      <circle cx="8" cy="3" r="1.3" />
      <circle cx="13" cy="6" r="1.3" />
      <circle cx="9.5" cy="13" r="1.3" />
      <path d="m4 7 3-3M9.2 3.6l2.6 1.7M12.2 7.1l-1.9 4.7M4.2 8.8l4.2 3.3" />
    </Icon>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3.5 3z" />
    </Icon>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 7.2V11" />
      <path d="M8 5.1h.01" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.2 4.2 11.8 11.8" />
      <path d="M11.8 4.2 4.2 11.8" />
    </Icon>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.2" y="5.2" width="7.8" height="7.8" rx="1.2" />
      <path d="M10.8 5.2V3.8A1.8 1.8 0 0 0 9 2H3.8A1.8 1.8 0 0 0 2 3.8V9a1.8 1.8 0 0 0 1.8 1.8h1.4" />
    </Icon>
  );
}

export function AttachIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12.8 8.2 7.1 13.9a3.1 3.1 0 0 1-4.4-4.4l6.5-6.5a2.1 2.1 0 1 1 3 3L5.7 12.5a1.05 1.05 0 1 1-1.5-1.5l5.3-5.3" />
    </Icon>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6.1" y="2.4" width="3.8" height="7.2" rx="1.9" />
      <path d="M4.2 8.4a3.8 3.8 0 0 0 7.6 0" />
      <path d="M8 12.2v1.8M5.4 14h5.2" />
    </Icon>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 4.5h10M3 8h10M3 11.5h10" />
    </Icon>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.1" />
    </Icon>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 12.8V3.4" />
      <path d="M4.4 6.8 8 3.2 11.6 6.8" />
    </Icon>
  );
}

export function SteerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.4 8h9.2" />
      <path d="M9.4 4.8 12.6 8 9.4 11.2" />
    </Icon>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13 5.6V2.8l-1.4 1.4A5.6 5.6 0 1 0 13.4 10" />
      <path d="M9.8 2.8H13v3.1" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3v10M3 8h10" />
    </Icon>
  );
}

export function EditIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m3 11.8.5-2.6 6.8-6.8 2.3 2.3-6.8 6.8z" />
      <path d="M9.6 3.1 11.9 5.4M3 13h10" />
    </Icon>
  );
}

export function SaveIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 2.5h8.2l1.8 1.8v9.2H3z" />
      <path d="M5 2.5v4h5v-4M5.2 13.5V9h5.6v4.5" />
    </Icon>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.25 4.5h9.5" />
      <path d="M6.1 4.5V3.2c0-.4.3-.7.7-.7h2.4c.4 0 .7.3.7.7v1.3" />
      <path d="M5.1 4.5 5.7 13h4.6l.6-8.5" />
      <path d="M6.9 7.1v3.8M9.1 7.1v3.8" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m3.2 8.2 3 3 6.6-6.6" />
    </Icon>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 10.5v-8M4.8 5.7 8 2.5l3.2 3.2M3 9.5v4h10v-4" />
    </Icon>
  );
}

export function ResetIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.2 5.8V2.9l1.5 1.5A5.4 5.4 0 1 1 2.8 10" />
      <path d="M3.2 2.9v3.3h3.3" />
    </Icon>
  );
}

export function LogOutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 3H3v10h3.5M8.5 5l3 3-3 3M5.5 8h6" />
    </Icon>
  );
}
