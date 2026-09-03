import { z } from "zod";

export const SignupSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters.")
    .max(80, "Name is too long."),
  email: z.string().trim().email("Enter a valid email address."),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(72, "Password is too long."),
});

export const LoginSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

export type AuthFormState = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  message?: string;
} | undefined;
