export function validateText(
  value: string,
  {
    minLength = 1,
    maxLength = 255,
    fieldName = "Field",
  }: {
    minLength?: number;
    maxLength?: number;
    fieldName?: string;
  }
) {
  const clean = value.trim();

  if (clean.length < minLength) {
    return {
      ok: false,
      error: `${fieldName} is required.`,
      value: clean,
    };
  }

  if (clean.length > maxLength) {
    return {
      ok: false,
      error: `${fieldName} cannot exceed ${maxLength} characters.`,
      value: clean,
    };
  }

  return {
    ok: true,
    value: clean,
  };
}