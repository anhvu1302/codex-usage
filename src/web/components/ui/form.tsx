import type * as LabelPrimitive from "@radix-ui/react-label";
import { Slot } from "@radix-ui/react-slot";
import type { ComponentPropsWithoutRef, ElementRef, HTMLAttributes, ReactNode } from "react";
import { createContext, forwardRef, useContext, useId } from "react";
import {
  Controller,
  FormProvider,
  useFormContext,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";

import { Label } from "@/web/components/ui/label";
import { cn } from "@/web/lib/utils";

const Form = FormProvider;
const FormFieldContext = createContext<{ name: string }>({ name: "" });
const FormItemContext = createContext<{ id: string }>({ id: "" });

function FormField<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>>(
  props: ControllerProps<TFieldValues, TName>,
) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
}

function useFormField() {
  const fieldContext = useContext(FormFieldContext);
  const itemContext = useContext(FormItemContext);
  const { getFieldState, formState } = useFormContext();
  const fieldState = getFieldState(fieldContext.name, formState);
  const id = itemContext.id;

  return {
    ...fieldState,
    formDescriptionId: `${id}-form-item-description`,
    formItemId: `${id}-form-item`,
    formMessageId: `${id}-form-item-message`,
    name: fieldContext.name,
  };
}

const FormItem = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, reference) => {
    const id = useId();
    return (
      <FormItemContext.Provider value={{ id }}>
        <div ref={reference} className={cn("space-y-2", className)} {...props} />
      </FormItemContext.Provider>
    );
  },
);
FormItem.displayName = "FormItem";

const FormLabel = forwardRef<
  ElementRef<typeof LabelPrimitive.Root>,
  ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, reference) => {
  const { error, formItemId } = useFormField();
  return (
    <Label
      ref={reference}
      className={cn(error && "text-destructive", className)}
      htmlFor={formItemId}
      {...props}
    />
  );
});
FormLabel.displayName = "FormLabel";

const FormControl = forwardRef<ElementRef<typeof Slot>, ComponentPropsWithoutRef<typeof Slot>>(
  ({ ...props }, reference) => {
    const { error, formDescriptionId, formItemId, formMessageId } = useFormField();
    return (
      <Slot
        ref={reference}
        id={formItemId}
        aria-describedby={error ? `${formDescriptionId} ${formMessageId}` : formDescriptionId}
        aria-invalid={Boolean(error)}
        {...props}
      />
    );
  },
);
FormControl.displayName = "FormControl";

const FormDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, reference) => {
    const { formDescriptionId } = useFormField();
    return (
      <p
        ref={reference}
        id={formDescriptionId}
        className={cn("text-muted-foreground text-sm", className)}
        {...props}
      />
    );
  },
);
FormDescription.displayName = "FormDescription";

const FormMessage = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, children, ...props }, reference) => {
    const { error, formMessageId } = useFormField();
    const body: ReactNode = error?.message ?? children;
    if (!body) return null;
    return (
      <p
        ref={reference}
        id={formMessageId}
        className={cn("text-destructive text-sm font-medium", className)}
        {...props}
      >
        {body}
      </p>
    );
  },
);
FormMessage.displayName = "FormMessage";

export {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  useFormField,
};
