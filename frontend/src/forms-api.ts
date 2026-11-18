import { base, object, uuid } from "./api";

export type FormField = {
  key: string;
  label: string;
  type: "text" | "textarea" | "email" | "cep";
  required: boolean;
};
export type FormConfig = {
  title: string;
  description: string;
  city: string;
  fields: FormField[];
};
export type SavedForm = FormConfig & {
  source?: "native" | "google-forms";
  id: string;
  automationId: string;
  revision: number;
  published: boolean;
  createdAt: string;
  updatedAt: string;
};
export type Submission = {
  fields: FormField[];
  id: string;
  revision: number;
  createdAt: string;
  answers: Record<string, string>;
};
export type FormIntent = {
  expectedRevision: number;
  idempotencyKey: string;
  answers: Record<string, string>;
};
export class FormError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export async function formsRequest(
  path: string,
  signal: AbortSignal,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base}/forms${path}`, {
      method,
      signal,
      credentials: "omit",
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new FormError("uncertain");
  }
  let value: unknown;
  try {
    value = await res.json();
  } catch {
    throw new FormError("uncertain");
  }
  if (!res.ok)
    throw new FormError(
      object(value) && typeof value.error === "string"
        ? value.error
        : "uncertain",
    );
  return value;
}
export function savedForm(v: unknown): SavedForm {
  if (
    !object(v) ||
    !uuid(v.id) ||
    !uuid(v.automationId) ||
    !Number.isInteger(v.revision) ||
    typeof v.published !== "boolean" ||
    typeof v.title !== "string" ||
    typeof v.description !== "string" ||
    typeof v.city !== "string" ||
    !Array.isArray(v.fields) ||
    !v.fields.every(
      (f) =>
        object(f) &&
        typeof f.key === "string" &&
        typeof f.label === "string" &&
        ["text", "textarea", "email", "cep"].includes(String(f.type)) &&
        typeof f.required === "boolean",
    )
  )
    throw new FormError("invalid_response");
  return v as SavedForm;
}
export const getForm = async (id: string, signal: AbortSignal) =>
  savedForm(await formsRequest(`/${id}`, signal));
export function formError(error: unknown): string {
  const code = error instanceof FormError ? error.code : "uncertain";
  return (
    (
      {
        not_found: "Formulário não encontrado.",
        invalid_google_connection:
          "Confira o link completo do Google Forms, os nomes das perguntas e a URL HTTPS pública. Você pode deixar a URL pública vazia ao criar a conexão e configurá-la depois.",
        forms_disabled:
          "Os serviços de formulário ou a consulta ViaCEP estão desabilitados. Confira a prontidão do ambiente.",
        invalid_form:
          "Revise os campos. O formulário precisa de um CEP obrigatório e nomes válidos.",
        invalid_answers:
          "Revise as respostas: campos obrigatórios, CEP com 8 dígitos, e-mail e limite total de texto.",
        revision_conflict:
          "O formulário mudou. Recarregue a página antes de continuar.",
        pause_before_edit: "Pause o formulário antes de editar.",
        form_paused: "Este formulário não está recebendo respostas.",
        automation_changed:
          "A automação vinculada foi alterada. Pause e publique novamente pelo formulário.",
        idempotency_conflict:
          "Esta identificação já foi usada com outra resposta. Não reenviamos o conteúdo alterado.",
        invalid_response: "A API retornou uma resposta inesperada.",
      } as Record<string, string>
    )[code] ??
    "Não foi possível confirmar a operação. Verifique a conexão e tente recuperar a mesma solicitação."
  );
}
