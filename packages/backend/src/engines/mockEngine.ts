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
    // La etapa respondida llega en el system prompt ("STAGE N of 3"); respuestas de 1-2 palabras se repiten
    const step = Number(options.systemPrompt.match(/STAGE (\d) of 3/)?.[1] ?? 1) + 1;
    if (isPlacement && options.userMessage.trim().split(/\s+/).length < 3) {
      return `[SPOKEN RESPONSE]
No worries, take your time! Could you tell me a little more? For example, you could start with: "Well, I work as..."

[SPANISH]
¡Tranquilo, tómate tu tiempo! ¿Me cuentas un poco más? Por ejemplo, podrías empezar con: "Well, I work as..."

[STEP_STATUS] repeat`;
    }

    if (isPlacement) {
      if (step <= 1) {
        return `[SPOKEN RESPONSE]
Hey there! Welcome aboard! I'm Ethan, your vocal coach. To get our baseline, tell me a bit about yourself. What do you do on a typical day, and what made you want to level up your English right now?

[SPANISH]
¡Hola, bienvenido! Soy Ethan, tu coach de voz. ¿Qué haces en un día normal y por qué quieres mejorar tu inglés ahora?

[STEP_STATUS] advance`;
      }

      if (step === 2) {
        return `[SPOKEN RESPONSE]
That's awesome! I hear you loud and clear. Now let me test your spontaneous thinking. If you had to choose between working 100% remotely from anywhere in the world or going to a lively office with free food and colleagues every day, which would you pick and why?

[SPANISH]
¡Genial! Te entiendo perfecto. Ahora probemos tu forma de pensar en el momento: ¿trabajar 100 % remoto desde cualquier lugar o ir a una oficina animada con comida gratis? ¿Cuál eliges y por qué?

[NATIVE UPGRADE]
- 📌 *You said:* "I am agree with that"
- ⚡ *Native way:* "I totally agree with that"
- 🗣️ *Pronunciation:* "ai TO-ta-li a-GRII with dat"
- 💡 *Key takeaway:* In English, 'agree' is an active verb, not an adjective—so say 'I agree', never 'I am agree'.
- 🇪🇸 *Explicación:* En inglés "agree" ya es el verbo (estar de acuerdo): se escribe "I agree", sin "am". Ojo: la "th" de "that" se pronuncia con la lengua entre los dientes.

[STEP_STATUS] advance`;
      }

      if (step === 3) {
        return `[SPOKEN RESPONSE]
Great reasoning! Let's do one quick real-world scenario. Imagine your flight was canceled at the last minute and the airline agent tells you the next one leaves tomorrow. How would you negotiate to get a hotel voucher right now?

[SPANISH]
¡Muy bien razonado! Ahora un caso real: te cancelan el vuelo a última hora y el siguiente sale mañana. ¿Cómo negociarías un bono de hotel ahora mismo?

[NATIVE UPGRADE]
- 📌 *You said:* "It depends of the day"
- ⚡ *Native way:* "It depends on the day"
- 🗣️ *Pronunciation:* "it di-PENDS on de DEI"
- 💡 *Key takeaway:* Always use the preposition 'on' with 'depend', never 'of'.
- 🇪🇸 *Explicación:* Aunque en español decimos "depende de", en inglés siempre es "depend on". Se escribe "depends" con s final en tercera persona.

[STEP_STATUS] advance`;
      }

      return `[SPOKEN RESPONSE]
Fantastic job handling that! You've got good natural instincts and your confidence is already in the right place. Based on our quick diagnostic, you're at B1 level, and I've got our action plan ready!

[SPANISH]
¡Lo hiciste genial! Tienes buen instinto y confianza. Según el diagnóstico estás en nivel B1 y ya tengo listo nuestro plan de acción.

[NATIVE UPGRADE]
- 📌 *You said:* "I lose the bus"
- ⚡ *Native way:* "I missed the bus"
- 🗣️ *Pronunciation:* "ai MIST de BAS"
- 💡 *Key takeaway:* In English we 'miss' transportation or opportunities, and 'lose' physical objects like keys or wallets.
- 🇪🇸 *Explicación:* "Perder el bus" es "miss the bus" (no llegar a tiempo); "lose" es perder un objeto. "Missed" se pronuncia con una sola sílaba: "mist".

[STEP_STATUS] advance

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

[SPANISH]
Muy buen punto. Cuando manejas proyectos así, quieres arrancar con todo. ¿Cuál crees que es tu mayor obstáculo para hablar más seguido durante la semana?

[NATIVE UPGRADE]
- 📌 *You said:* "Actually I am working in this"
- ⚡ *Native way:* "Currently, I'm working on this"
- 🗣️ *Pronunciation:* "KE-rent-li, aim WER-king on dis"
- 💡 *Key takeaway:* 'Actually' means 'de hecho' or 'en realidad'. When you want to say 'actualmente', use 'currently' or 'right now'.
- 🇪🇸 *Explicación:* "Actually" es un falso amigo: significa "en realidad". Para "actualmente" usa "currently". Y se trabaja "on" un proyecto, no "in".

[SCORES] fluency=3 vocabulary=4 grammar=3`;
  }
}
