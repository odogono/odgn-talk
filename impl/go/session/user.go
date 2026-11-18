package session

// Prompt is a user prompt as the person sees it (chapter 12, Prompts). Kind is
// confirm, choose or enter; an omitted prompt, default or title is "".
type Prompt struct {
	Kind, Message, Prompt, Fallback string
	Items                           []string
	Multiple                        bool
}
