export default async (req) => {
  console.log("Running Scheduled Daily Job...");
  return new Response(JSON.stringify({ 
    status: "Success", 
    message: "Daily schedule executed successfully!",
    time: new Date().toISOString()
  }), {
    headers: { "Content-Type": "application/json" }
  });
};

export const config = {
  schedule: "@daily"
};
