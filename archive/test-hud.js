/**
 * Quick test script for HUD extension
 * Run this in the Peek console to test the HUD
 */

// Test if HUD extension loaded
const testHud = async () => {
  const api = window.app;

  // Check if HUD command is registered
  const commands = await api.commands.getAll();
  const hudCommand = commands.data?.find(c => c.name === 'hud');

  console.log('HUD command registered:', !!hudCommand);

  if (hudCommand) {
    console.log('HUD command:', hudCommand);

    // Try to execute the HUD command
    try {
      const result = await hudCommand.execute();
      console.log('HUD toggle result:', result);
    } catch (error) {
      console.error('Error toggling HUD:', error);
    }
  } else {
    console.error('HUD command not found in:', commands.data?.map(c => c.name));
  }
};

testHud();
