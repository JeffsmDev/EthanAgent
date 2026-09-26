import { AIEngine, EngineGenerateOptions, EngineResult } from './aiProvider.js';

export class MockEngine implements AIEngine {
  readonly provider = 'mock' as const;
  readonly model = 'scripted';
  name = 'Mock Diagnostic Engine';

  async generateResponse(options: EngineGenerateOptions): Promise<EngineResult> {
    return { text: this.scriptedReply(options), model: this.model, usage: null };
  }

  private scriptedReply(options: EngineGenerateOptions): string {
    const isPlacement = options.systemPrompt.includes('PLACEMENT');
    // El paso llega en el system prompt ("Step N of 4"); el historial incluye la bienvenida, no sirve para contar
    const step = Number(options.systemPrompt.match(/Step (\d) of 4/)?.[1] ?? 1);

    if (isPlacement) {
      if (step <= 1) {
        return `[SPOKEN RESPONSE]
Hey there! Welcome aboard! I'm Ethan, your vocal coach. To get our baseline, tell me a bit about yourself. What do you do on a typical day, and what made you want to level up your English right now?`;
      }

      if (step === 2) {
        return `[SPOKEN RESPONSE]
That's awesome! I hear you loud and clear. Now let me test your spontaneous thinking. If you had to choose between working 100% remotely from anywhere in the world or going to a lively office with free food and colleagues every day, which would you pick and why?

[NATIVE UPGRADE]
- 📌 *You said:* "I am agree with that"
- ⚡ *Native way:* "I totally agree with that"
- 💡 *Key takeaway:* In English, 'agree' is an active verb, not an adjective—so say 'I agree', never 'I am agree'.`;
      }

      if (step === 3) {
        return `[SPOKEN RESPONSE]
Great reasoning! Let's do one quick real-world scenario. Imagine your flight was canceled at the last minute and the airline agent tells you the next one leaves tomorrow. How would you negotiate to get a hotel voucher right now?

[NATIVE UPGRADE]
- 📌 *You said:* "It depends of the day"
- ⚡ *Native way:* "It depends ON the day"
- 💡 *Key takeaway:* Always use the preposition 'on' with 'depend', never 'of'.`;
      }

      return `[SPOKEN RESPONSE]
Fantastic job handling that! You've got good natural instincts and your confidence is already in the right place. Based on our quick diagnostic, I've got your starting level and our action plan ready!

[NATIVE UPGRADE]
- 📌 *You said:* "I lose the bus"
- ⚡ *Native way:* "I missed the bus"
- 💡 *Key takeaway:* In English we 'miss' transportation or opportunities, and 'lose' physical objects like keys or wallets.

\`\`\`json
{
  "testCompleted": true,
  "assignedLevel": "B1",
  "strengths": ["Clear conversational rhythm", "Willingness to take risks without translating word-for-word"],
  "priorityAreas": ["Eliminating Spanish preposition traps (depend on, good at)", "Using active verbs (agree instead of am agree)", "Expanding natural phrasal verbs"],
  "firstSessionRecommendedTheme": "Workplace Negotiations & Natural Collocations"
}
\`\`\``;
    }

    return `[SPOKEN RESPONSE]
That's a very solid point. When you're dealing with projects like this, you really want to hit the ground running. What do you think is your biggest obstacle to speaking more often during the week?

[NATIVE UPGRADE]
- 📌 *You said:* "Actually I am working in this"
- ⚡ *Native way:* "Currently, I'm working on this"
- 💡 *Key takeaway:* 'Actually' means 'de hecho' or 'en realidad'. When you want to say 'actualmente', use 'currently' or 'right now'.`;
  }
}
