import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster(props: ToasterProps) {
  return <Sonner closeButton position="bottom-right" {...props} />;
}

export { Toaster };
