import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import Dashboard from "@/pages/Dashboard";
import Signals from "@/pages/Signals";
import Analyses from "@/pages/Analyses";
import Setup from "@/pages/Setup";
import Scorecard from "@/pages/Scorecard";
import NotFound from "@/pages/not-found";
import Sidebar from "@/components/Sidebar";

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocation}>
        <div className="flex h-screen overflow-hidden bg-background">
          <Sidebar />
          <main className="flex-1 overflow-auto">
            <Switch>
              <Route path="/" component={Dashboard} />
              <Route path="/signals" component={Signals} />
              <Route path="/analyses" component={Analyses} />
              <Route path="/scorecard" component={Scorecard} />
              <Route path="/setup" component={Setup} />
              <Route component={NotFound} />
            </Switch>
          </main>
        </div>
      </Router>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
