import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Bot, User, Loader2 } from "lucide-react";

const SESSION_ID = `session-${Date.now()}`;

interface ChatMessage {
  id: number;
  role: string;
  content: string;
  createdAt: number;
}

export default function ChatPanel() {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const { data: messages = [] } = useQuery<ChatMessage[]>({
    queryKey: ["/api/chat", SESSION_ID],
    queryFn: () => apiRequest("GET", `/api/chat/${SESSION_ID}`).then(r => r.json()),
    refetchInterval: 3000,
  });

  const sendMutation = useMutation({
    mutationFn: (message: string) =>
      apiRequest("POST", "/api/chat", { message, sessionId: SESSION_ID }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/chat", SESSION_ID] });
    },
  });

  const handleSend = () => {
    if (!input.trim() || sendMutation.isPending) return;
    sendMutation.mutate(input.trim());
    setInput("");
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const quickQuestions = [
    "What's the current bias?",
    "Is this a valid ICT setup?",
    "Where's my entry and stop?",
    "Should I wait for London close?",
  ];

  return (
    <div className="flex flex-col h-full bg-card border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-card">
        <Bot className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">AI Analyst Chat</span>
        <span className="ml-auto text-xs text-muted-foreground font-mono">ICT · NQ1!</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
        {messages.length === 0 && (
          <div className="text-center py-8">
            <Bot className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">Ask me anything about the current NQ setup.</p>
            <p className="text-xs text-muted-foreground mt-1">Kill zones, FVGs, structure, entries — I'm watching the signals.</p>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-2.5 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
            <div className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
              msg.role === "user" ? "bg-primary/20" : "bg-accent"
            }`}>
              {msg.role === "user"
                ? <User className="w-3.5 h-3.5 text-primary" />
                : <Bot className="w-3.5 h-3.5 text-muted-foreground" />
              }
            </div>
            <div className={`max-w-[80%] rounded-xl px-3.5 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${
              msg.role === "user"
                ? "bg-primary/10 text-foreground rounded-tr-sm"
                : "bg-muted text-foreground rounded-tl-sm"
            }`}>
              {msg.content}
            </div>
          </div>
        ))}
        {sendMutation.isPending && (
          <div className="flex gap-2.5">
            <div className="flex-shrink-0 w-7 h-7 rounded-full bg-accent flex items-center justify-center">
              <Bot className="w-3.5 h-3.5 text-muted-foreground" />
            </div>
            <div className="bg-muted rounded-xl rounded-tl-sm px-3.5 py-2.5">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Quick questions */}
      {messages.length === 0 && (
        <div className="px-4 pb-2 flex flex-wrap gap-1.5">
          {quickQuestions.map((q) => (
            <button
              key={q}
              onClick={() => { setInput(q); }}
              className="text-xs px-2.5 py-1.5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
              data-testid={`quick-q-${q.slice(0, 10).replace(/\s+/g, "-")}`}
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="p-3 border-t border-border flex gap-2">
        <Textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Ask about the current setup..."
          className="resize-none text-sm min-h-[40px] max-h-[120px] bg-background border-border"
          rows={1}
          data-testid="chat-input"
        />
        <Button
          size="icon"
          onClick={handleSend}
          disabled={!input.trim() || sendMutation.isPending}
          className="flex-shrink-0 bg-primary hover:bg-primary/90"
          data-testid="button-send"
        >
          <Send className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
